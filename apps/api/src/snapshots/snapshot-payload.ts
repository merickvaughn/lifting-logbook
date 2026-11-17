import { promisify } from 'node:util';
import { isDate } from 'node:util/types';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';
import { OverwriteChanges, StoredSnapshot } from '../ports/IDataSnapshotRepository';
import { TrainingData } from '../ports/ITrainingDataRepository';

// The async calls, so compressing a long history doesn't block the event loop while its
// transaction holds the locks.
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

/**
 * A snapshot's rows as stored in `data_snapshot.rows` (#1309, proposal decision 21): JSON with
 * each `Date` written as `{"$date": ISO}`, so it comes back a `Date`, gzip-compressed.
 * `version` lets a later release read an older snapshot during its 30 days.
 */
const PAYLOAD_VERSION = 1;

interface Payload {
  version: number;
  data: TrainingData;
  /** An overwrite's changes (#1182). A clear's payload has none. */
  overwrite?: OverwriteChanges;
}

/** A snapshot's rows, and an overwrite's changes beside them. */
export type SnapshotContents = Pick<StoredSnapshot, 'data' | 'overwrite'>;

function isDateMarker(value: unknown): value is { $date: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { $date?: unknown }).$date === 'string'
  );
}

export async function encodeSnapshotRows({ data, overwrite }: SnapshotContents): Promise<Buffer> {
  const payload: Payload = { version: PAYLOAD_VERSION, data, ...(overwrite ? { overwrite } : {}) };
  // `this[key]` is the value before `Date.prototype.toJSON` turned it into a string. `isDate`
  // rather than `instanceof`, which misses a Date made in another realm, such as one a Jest
  // sandbox's caller passed in.
  const json = JSON.stringify(payload, function (this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    return isDate(raw) ? { $date: raw.toISOString() } : value;
  });
  return gzip(Buffer.from(json, 'utf8'));
}

export async function decodeSnapshotRows(rows: Buffer): Promise<SnapshotContents> {
  const payload = JSON.parse((await gunzip(rows)).toString('utf8'), (_key, value: unknown) =>
    isDateMarker(value) ? new Date(value.$date) : value,
  ) as Payload;
  if (payload.version !== PAYLOAD_VERSION) {
    throw new Error(`snapshot payload version ${payload.version} is not one this release reads`);
  }
  return { data: payload.data, ...(payload.overwrite ? { overwrite: payload.overwrite } : {}) };
}
