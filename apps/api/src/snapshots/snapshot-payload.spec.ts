import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { TRAINING_TABLES, TrainingData } from '../ports/ITrainingDataRepository';
import { decodeSnapshotRows, encodeSnapshotRows } from './snapshot-payload';

const empty = (): TrainingData =>
  Object.fromEntries(TRAINING_TABLES.map((t) => [t, []])) as unknown as TrainingData;

describe('snapshot payload (#1309)', () => {
  it('brings dates back as dates and leaves strings that look like dates alone', () => {
    const data = empty();
    data.liftRecords.push({ program: '5-3-1', date: new Date('2025-06-02T00:00:00.000Z'), notes: '2025-06-02T00:00:00.000Z' });

    const [row] = decodeSnapshotRows(encodeSnapshotRows(data)).liftRecords;

    expect(row?.['date']).toEqual(new Date('2025-06-02T00:00:00.000Z'));
    expect(row?.['notes']).toBe('2025-06-02T00:00:00.000Z');
  });

  it('keeps a date made in another realm, as structuredClone makes under Jest', () => {
    const data = empty();
    data.macrocycles.push({ program: '5-3-1', startDate: runInNewContext('new Date("2025-01-06T00:00:00.000Z")') as Date });

    expect(decodeSnapshotRows(encodeSnapshotRows(data)).macrocycles[0]?.['startDate']).toEqual(new Date('2025-01-06T00:00:00.000Z'));
  });

  it('refuses a payload version this release doesn’t read', () => {
    const rows = gzipSync(Buffer.from(JSON.stringify({ version: 2, data: empty() })));

    expect(() => decodeSnapshotRows(rows)).toThrow('snapshot payload version 2 is not one this release reads');
  });
});
