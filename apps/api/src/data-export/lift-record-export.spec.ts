import type { LiftRecordExportRow } from '@lifting-logbook/core';
import {
  calendarDay,
  describeParts,
  exportParts,
  liftRecordExportFileName,
  splitFingerprint,
  withStatuses,
} from './lift-record-export';

const date = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const record = (overrides: Partial<LiftRecordExportRow> = {}): LiftRecordExportRow => ({
  program: 'rpt',
  macrocycleNum: 1,
  workoutNum: 1,
  date: date('2026-01-05'),
  lift: 'Bench Press',
  occurrence: 0,
  setNum: 1,
  weight: 100,
  reps: 5,
  notes: '',
  modifications: [],
  ...overrides,
});

describe('withStatuses (#1308)', () => {
  const macrocycles = [
    { program: 'rpt', macrocycleNum: 1, status: 'completed', statusChosen: true },
    { program: '5-3-1', macrocycleNum: 1, status: 'overran', statusChosen: true },
    { program: 'rpt', macrocycleNum: 3, status: 'in-progress', statusChosen: false },
    { program: 'non-cycle', macrocycleNum: 1, status: 'unknown', statusChosen: true },
  ];

  it('gives each set its own program and number’s status', () => {
    const rows = withStatuses([record(), record({ program: '5-3-1' })], macrocycles);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'overran']);
  });

  it('leaves out a status the rules inferred, which import would otherwise read as chosen', () => {
    expect(withStatuses([record({ macrocycleNum: 3 })], macrocycles).map((r) => r.status)).toEqual([null]);
  });

  it('gives none to a non-cycle set, or a set whose macrocycle has no row', () => {
    const rows = withStatuses([record({ program: 'non-cycle' }), record({ macrocycleNum: 2 })], macrocycles);
    expect(rows.map((r) => r.status)).toEqual([null, null]);
  });
});

describe('exportParts and describeParts (#1308)', () => {
  it('cuts between macrocycles and dates each part by its first and last set', () => {
    const rows = [
      record({ macrocycleNum: 1, date: date('2026-01-05') }),
      record({ macrocycleNum: 1, date: date('2026-01-07'), setNum: 2 }),
      record({ macrocycleNum: 2, date: date('2026-02-01') }),
    ];
    const parts = exportParts(rows, [], 2);
    expect(parts.map((p) => p.map((r) => r.macrocycleNum))).toEqual([[1, 1], [2]]);
    expect(describeParts(parts)).toEqual([
      { part: 1, rows: 2, from: '2026-01-05', to: '2026-01-07' },
      { part: 2, rows: 1, from: '2026-02-01', to: '2026-02-01' },
    ]);
  });

  it('has no parts for no sets', () => {
    expect(describeParts(exportParts([], []))).toEqual([]);
  });
});

describe('splitFingerprint (#1308)', () => {
  const parts = [[record(), record({ setNum: 2 })], [record({ macrocycleNum: 2 })]];

  it('is the same for the same sets in the same parts, whatever their weights', () => {
    const reweighed = parts.map((rows) => rows.map((r) => ({ ...r, weight: r.weight + 5, notes: 'edited' })));
    expect(splitFingerprint(reweighed)).toBe(splitFingerprint(parts));
    expect(splitFingerprint(parts)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a set is added or removed, or one moves to another part', () => {
    const [first = [], second = []] = parts;
    const base = splitFingerprint(parts);
    expect(splitFingerprint([[...first, record({ setNum: 3 })], second])).not.toBe(base);
    expect(splitFingerprint([first.slice(1), second])).not.toBe(base);
    expect(splitFingerprint([first.slice(0, 1), [...first.slice(1), ...second]])).not.toBe(base);
  });
});

describe('liftRecordExportFileName', () => {
  it('names the part only when there is more than one', () => {
    const now = date('2026-11-15');
    expect(liftRecordExportFileName(now, 1, 1)).toBe('lift-records-2026-11-15.csv');
    expect(liftRecordExportFileName(now, 2, 3)).toBe('lift-records-2026-11-15-part-2-of-3.csv');
  });
});

describe('calendarDay', () => {
  it('reads a real day as UTC midnight', () => {
    expect(calendarDay('2026-02-28')).toEqual(date('2026-02-28'));
  });

  it.each(['2026-02-30', '2026-13-01', 'not-a-day'])('refuses %j', (text) => {
    expect(calendarDay(text)).toBeNull();
  });
});
