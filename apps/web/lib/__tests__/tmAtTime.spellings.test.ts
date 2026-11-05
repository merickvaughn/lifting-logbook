import type { TrainingMaxHistoryEntryResponse } from '@lifting-logbook/types';
import { buildTmAtTimeIndex } from '@/lib/tmAtTime';

function entry(lift: string, date: string, weight: number): TrainingMaxHistoryEntryResponse {
  return { id: `${lift}-${date}`, lift, weight, unit: 'lbs', date, isPR: false, source: 'program', goalMet: false };
}

// #1135: a record and its training-max history can spell the lift differently.
describe('buildTmAtTimeIndex across stored spellings', () => {
  it('finds a bench-press entry for a Bench Press record, and the reverse', () => {
    expect(buildTmAtTimeIndex([entry('bench-press', '2026-01-01', 200)]).find('Bench Press', '2026-02-01')?.weight).toBe(200);
    expect(buildTmAtTimeIndex([entry('Bench Press', '2026-01-01', 200)]).find('bench-press', '2026-02-01')?.weight).toBe(200);
  });

  it('takes the entry in force on the date, across both spellings', () => {
    const index = buildTmAtTimeIndex([
      entry('Bench Press', '2026-01-01', 200),
      entry('bench-press', '2026-03-01', 220),
    ]);
    expect(index.find('Bench Press', '2026-02-01')?.weight).toBe(200);
    expect(index.find('Bench Press', '2026-04-01')?.weight).toBe(220);
    expect(index.find('Bench Press', '2025-12-01')).toBeNull();
  });

  it('prefers the exact name over another name for one lift', () => {
    const index = buildTmAtTimeIndex([
      entry('C. Lat Raise', '2026-03-01', 25),
      entry('Lateral Raise', '2026-01-01', 40),
    ]);
    expect(index.find('Lateral Raise', '2026-04-01')?.weight).toBe(40);
  });
});
