import { summarizeBlock, type LiftRecord } from '@src/core';
import { block, entry } from './focusFixtures';

// LiftRecord dates are stored at UTC midnight (parseLiftRecords, issue #894), so fixtures
// use UTC midnights too. The summary reads them as UTC calendar days, which keeps the result
// the same on every host time zone.
const record = (lift: string, iso: string, weight: number, reps: number): LiftRecord => ({
  program: 'p',
  macrocycleNum: 1,
  workoutNum: 1,
  date: new Date(`${iso}T00:00:00.000Z`),
  lift,
  setNum: 1,
  weight,
  reps,
  notes: '',
});

describe('summarizeBlock', () => {
  const b = block({
    period: 'monthly',
    start: '2026-09-01',
    pool: [entry('Hammer Curl'), entry('Cable Curl'), entry('New Lift'), entry('Flat Lift')],
  });

  it('totals pool-lift sets inside the range and finds PRs against the best before it', () => {
    const summary = summarizeBlock(
      [
        record('Hammer Curl', '2026-08-31', 35, 12),
        record('Hammer Curl', '2026-09-01', 40, 10),
        record('Hammer Curl', '2026-09-01', 40, 8),
        record('Cable Curl', '2026-08-20', 50, 10),
        record('Cable Curl', '2026-09-10', 50, 12),
        record('New Lift', '2026-09-10', 20, 10),
        record('Flat Lift', '2026-08-01', 30, 10),
        record('Flat Lift', '2026-09-30', 30, 10),
        record('Squat', '2026-09-10', 300, 5),
        record('Hammer Curl', '2026-10-01', 60, 10),
      ],
      b,
    );
    expect(summary.sessions).toBe(3);
    expect(summary.sets).toBe(5);
    expect(summary.volume).toBe(400 + 320 + 600 + 200 + 300);
    expect(summary.prs).toEqual([
      { lift: 'Hammer Curl', weight: 40, reps: 10, previousWeight: 35, previousReps: 12 },
      { lift: 'Cable Curl', weight: 50, reps: 12, previousWeight: 50, previousReps: 10 },
    ]);
  });

  it('counts the first and last day and excludes the days either side', () => {
    const summary = summarizeBlock(
      [
        record('Hammer Curl', '2026-08-31', 100, 1),
        record('Hammer Curl', '2026-09-01', 10, 1),
        record('Hammer Curl', '2026-09-30', 10, 1),
        record('Hammer Curl', '2026-10-01', 100, 1),
      ],
      b,
    );
    expect(summary).toEqual({ sessions: 2, sets: 2, volume: 20, prs: [] });
  });

  it('ignores records with an invalid date', () => {
    const invalid = { ...record('Hammer Curl', '2026-09-05', 40, 10), date: new Date('not a date') };
    expect(summarizeBlock([invalid], b)).toEqual({ sessions: 0, sets: 0, volume: 0, prs: [] });
  });

  it('is empty with no records', () => {
    expect(summarizeBlock([], b)).toEqual({ sessions: 0, sets: 0, volume: 0, prs: [] });
  });
});
