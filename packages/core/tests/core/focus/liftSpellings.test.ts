import { selectForDay, summarizeBlock, type LiftRecord } from '@src/core';
import { block, entry, resolveMuscles } from './focusFixtures';

const record = (lift: string, iso: string, weight: number): LiftRecord => ({
  program: 'p',
  macrocycleNum: 1,
  workoutNum: 1,
  date: new Date(`${iso}T00:00:00.000Z`),
  lift,
  setNum: 1,
  weight,
  reps: 5,
  notes: '',
});

// #1135: a pool names a lift one way, and its records can be stored another.
describe('summarizeBlock across stored spellings', () => {
  const b = block({ period: 'monthly', start: '2026-09-01', pool: [entry('Bench Press')] });

  it('counts a bench-press record for a Bench Press pool lift, and finds its PR', () => {
    const summary = summarizeBlock(
      [record('bench-press', '2026-08-15', 180), record('Bench Press', '2026-09-02', 185), record('bench-press', '2026-09-03', 190)],
      b,
    );
    expect(summary).toMatchObject({ sessions: 2, sets: 2 });
    expect(summary.prs).toEqual([
      { lift: 'Bench Press', weight: 190, reps: 5, previousWeight: 180, previousReps: 5 },
    ]);
  });

  it('counts a record for the pool entry with its exact name when two spell one lift', () => {
    const two = block({
      period: 'monthly',
      start: '2026-09-01',
      pool: [entry('Lateral Raise'), entry('C. Lat Raise')],
    });
    const summary = summarizeBlock(
      [record('C. Lat Raise', '2026-08-15', 20), record('C. Lat Raise', '2026-09-02', 25), record('Lateral Raise', '2026-09-02', 40)],
      two,
    );
    expect(summary.prs.map((pr) => pr.lift)).toEqual(['C. Lat Raise']);
  });

  it('does not credit a separately planned name to a pool lift', () => {
    const pool = block({ period: 'monthly', start: '2026-09-01', pool: [entry('Lateral Raise')] });
    const summary = summarizeBlock(
      [record('C. Lat Raise', '2026-08-15', 20), record('C. Lat Raise', '2026-09-02', 22), record('Lateral Raise', '2026-09-03', 25)],
      pool,
    );
    expect(summary).toMatchObject({ sessions: 1, sets: 1, prs: [] });
  });
});

describe('a rule lift across stored spellings', () => {
  it('drops a rule entry when its rule lift is planned under another spelling', () => {
    const b = block({ pool: [entry('A', { include: 'rule', ruleLift: 'bench-press' }), entry('B')] });
    const result = selectForDay(b, ['Bench Press'], 0, undefined, resolveMuscles);
    expect(result.skipped).toEqual([{ lift: 'A', reason: 'rule', detail: 'bench-press' }]);
  });
});
