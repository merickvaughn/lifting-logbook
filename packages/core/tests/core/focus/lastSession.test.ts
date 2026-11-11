import { FOCUS_LIMITS } from '@lifting-logbook/types';
import { prescribe, recordLastSessions, withoutStaleLastReps, type LiftRecord } from '@src/core';
import { block, entry } from './focusFixtures';

// Dates at UTC midnight, as lift records are stored (issue #894).
const record = (lift: string, iso: string, weight: number, reps: number, setNum = 1, workoutNum = 1): LiftRecord => ({
  program: 'p',
  macrocycleNum: 1,
  workoutNum,
  date: new Date(`${iso}T00:00:00.000Z`),
  lift,
  setNum,
  weight,
  reps,
  notes: '',
});

const TODAY = '2026-10-20';
const b = block({ pool: [entry('Lateral Raise'), entry('Face Pull')] });
const session = (iso: string, weight: number, reps: number[], lift = 'Lateral Raise') =>
  reps.map((r, i) => record(lift, iso, weight, r, i + 1));

describe('recordLastSessions', () => {
  it("records each lift's latest session in the block before today, so a topped session progresses", () => {
    const pool = recordLastSessions(
      b,
      [...session('2026-10-05', 25, [10, 10, 9]), ...session('2026-10-12', 25, [12, 12, 12]), ...session('2026-10-08', 20, [11], 'Face Pull')],
      TODAY,
    );
    expect(pool).toEqual([
      entry('Lateral Raise', { weight: 25, lastReps: [12, 12, 12], lastDate: '2026-10-12' }),
      entry('Face Pull', { weight: 20, lastReps: [11], lastDate: '2026-10-08' }),
    ]);
    const [lateral] = pool ?? [];
    expect(lateral && prescribe(b, lateral, 3, 2.5)).toMatchObject({ weight: 27.5, progressed: true });
  });

  it('records a session at the new weight below the top, so the plan holds that weight', () => {
    const recorded = entry('Lateral Raise', { weight: 25, lastReps: [12, 12, 12], lastDate: '2026-10-12' });
    const [lateral] =
      recordLastSessions(block({ pool: [recorded] }), session('2026-10-15', 27.5, [10, 9, 9]), TODAY) ?? [];
    expect(lateral).toMatchObject({ weight: 27.5, lastReps: [10, 9, 9], lastDate: '2026-10-15' });
    expect(lateral && prescribe(b, lateral, 3, 2.5)).toMatchObject({ weight: 27.5, progressed: false });
  });

  it("leaves today's sets for a later day, so a session in progress keeps its plan", () => {
    expect(recordLastSessions(b, session(TODAY, 25, [12, 12, 12]), TODAY)).toBeNull();
    expect(recordLastSessions(b, session(TODAY, 25, [12]), '2026-10-21')?.[0]).toMatchObject({ lastDate: TODAY });
  });

  it('ignores sets before the block started and lifts not in the pool', () => {
    expect(recordLastSessions(b, [...session('2026-09-30', 25, [12]), ...session('2026-10-05', 25, [12], 'Squat')], TODAY)).toBeNull();
  });

  it('records a session once, so a weight edited after it stands until the next one', () => {
    const edited = block({ pool: [entry('Lateral Raise', { weight: 30, lastReps: [12, 12, 12], lastDate: '2026-10-12' })] });
    expect(recordLastSessions(edited, session('2026-10-12', 25, [12, 12, 12]), TODAY)).toBeNull();
    expect(recordLastSessions(edited, session('2026-10-15', 30, [11]), TODAY)?.[0]).toMatchObject({ weight: 30, lastReps: [11] });
  });

  it('takes the lightest set as the weight, with every set in workout and set order', () => {
    const [lateral] =
      recordLastSessions(
        b,
        [
          record('Lateral Raise', '2026-10-12', 27.5, 12, 2, 2),
          record('Lateral Raise', '2026-10-12', 25, 9, 1, 2),
          record('Lateral Raise', '2026-10-12', 30, 8, 1, 1),
        ],
        TODAY,
      ) ?? [];
    expect(lateral).toMatchObject({ weight: 25, lastReps: [8, 9, 12] });
  });

  it('matches a record stored under the catalog id (#1135)', () => {
    const bench = block({ pool: [entry('Bench Press')] });
    expect(recordLastSessions(bench, [record('bench-press', '2026-10-12', 135, 12)], TODAY)?.[0]).toMatchObject({
      lift: 'Bench Press',
      weight: 135,
      lastReps: [12],
    });
  });

  it('caps what it records at the bounds the focus block DTOs accept', () => {
    const many = Array.from({ length: FOCUS_LIMITS.MAX_SETS + 2 }, (_, i) =>
      record('Lateral Raise', '2026-10-12', FOCUS_LIMITS.MAX_WEIGHT + 1, FOCUS_LIMITS.MAX_REPS + 1, i + 1),
    );
    const [lateral] = recordLastSessions(b, many, TODAY) ?? [];
    expect(lateral?.weight).toBe(FOCUS_LIMITS.MAX_WEIGHT);
    expect(lateral?.lastReps).toHaveLength(FOCUS_LIMITS.MAX_SETS);
    expect(lateral?.lastReps?.every((reps) => reps === FOCUS_LIMITS.MAX_REPS)).toBe(true);
  });

  it.each(['manual', 'percent_wave', 'rpe'] as const)('leaves a %s block alone', (progression) => {
    expect(recordLastSessions(block({ progression }), session('2026-10-12', 25, [12]), TODAY)).toBeNull();
  });
});

describe('withoutStaleLastReps', () => {
  const recorded = entry('Lateral Raise', { weight: 25, lastReps: [12, 12, 12], lastDate: '2026-10-12' });

  it('drops reps sent back unchanged with an edited weight, keeping lastDate', () => {
    expect(withoutStaleLastReps([recorded], [{ ...recorded, weight: 30 }])).toEqual([
      entry('Lateral Raise', { weight: 30, lastDate: '2026-10-12' }),
    ]);
  });

  it('keeps reps when the weight is unchanged, or the reps were sent with the new weight', () => {
    const sets = { ...recorded, sets: 4 };
    const both = { ...recorded, weight: 30, lastReps: [12, 11, 10] };
    expect(withoutStaleLastReps([recorded], [sets, both])).toEqual([sets, both]);
  });

  it('leaves an entry with no prior reps, or a new lift, alone', () => {
    const fresh = entry('Face Pull', { weight: 30, lastReps: [12] });
    expect(withoutStaleLastReps([entry('Lateral Raise')], [entry('Lateral Raise', { weight: 30 }), fresh])).toEqual([
      entry('Lateral Raise', { weight: 30 }),
      fresh,
    ]);
  });
});
