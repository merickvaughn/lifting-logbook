import { isDate } from 'node:util/types';
import { gunzipSync, gzipSync } from 'node:zlib';
import { TrainingData } from '../ports/ITrainingDataRepository';

/**
 * A snapshot's rows as stored in `data_snapshot.rows` (#1309, proposal decision 21): JSON with
 * each `Date` written as `{"$date": ISO}`, so it comes back a `Date`, gzip-compressed.
 * `version` lets a later release read an older snapshot during its 30 days.
 */
const PAYLOAD_VERSION = 1;

interface Payload {
  version: number;
  data: TrainingData;
}

function isDateMarker(value: unknown): value is { $date: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { $date?: unknown }).$date === 'string'
  );
}

export function encodeSnapshotRows(data: TrainingData): Buffer {
  const payload: Payload = { version: PAYLOAD_VERSION, data };
  // `this[key]` is the value before `Date.prototype.toJSON` turned it into a string. `isDate`
  // rather than `instanceof`, which misses a Date made in another realm (`structuredClone` under
  // Jest's sandbox, as the in-memory store's reads are).
  const json = JSON.stringify(payload, function (this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    return isDate(raw) ? { $date: raw.toISOString() } : value;
  });
  return gzipSync(Buffer.from(json, 'utf8'));
}

export function decodeSnapshotRows(rows: Buffer): TrainingData {
  const payload = JSON.parse(gunzipSync(rows).toString('utf8'), (_key, value: unknown) =>
    isDateMarker(value) ? new Date(value.$date) : value,
  ) as Payload;
  if (payload.version !== PAYLOAD_VERSION) {
    throw new Error(`snapshot payload version ${payload.version} is not one this release reads`);
  }
  return payload.data;
}
