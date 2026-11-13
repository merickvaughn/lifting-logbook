import { formatNonCycleReference, nonCycleReference, type NonCycleReferenceInput } from '@src/core';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Set = NonCycleReferenceInput['sets'][number];
const set = (fields: Partial<Set>): Set => ({
  lift: 'Squat',
  weight: 200,
  reps: 5,
  date: day('2026-03-01'),
  workoutNum: 1,
  setNum: 1,
  ...fields,
});

/** Squat: max 205 since February, 200 before it, and 8 reps at 200 last time. */
const seeded: NonCycleReferenceInput = {
  lift: 'Squat',
  trainingMaxes: [{ lift: 'Squat', weight: 205, dateUpdated: day('2026-02-01') }],
  history: [
    { lift: 'Squat', weight: 195, date: day('2025-12-01') },
    { lift: 'Squat', weight: 200, date: day('2026-01-01') },
    { lift: 'Squat', weight: 205, date: day('2026-02-01') },
  ],
  sets: [
    set({ weight: 200, reps: 6, date: day('2026-01-10') }),
    set({ weight: 200, reps: 8, date: day('2026-01-24') }),
    set({ weight: 205, reps: 3, date: day('2026-02-08') }),
  ],
};

const line = (input: NonCycleReferenceInput, unit: 'lbs' | 'kg' = 'lbs') => {
  const reference = nonCycleReference(input);
  return reference && formatNonCycleReference(reference, unit);
};

describe('the non-cycle workout reference line (decision 23, #1184)', () => {
  it('shows the max, the previous max and the reps last performed at it', () => {
    expect(line(seeded)).toBe('Training max 205 lbs. Last at 200 lbs: 8 reps.');
  });

  it('shows nothing for a lift with no max in the active program', () => {
    expect(line({ ...seeded, lift: 'Deadlift' })).toBeNull();
  });

  it('shows the max alone with no previous max', () => {
    const history = seeded.history.filter((entry) => entry.weight === 205);
    expect(line({ ...seeded, history })).toBe('Training max 205 lbs.');
    expect(line({ ...seeded, history: [] })).toBe('Training max 205 lbs.');
  });

  it('shows the max alone with no set at the previous max', () => {
    const sets = seeded.sets.filter((s) => s.weight !== 200);
    expect(line({ ...seeded, sets })).toBe('Training max 205 lbs.');
  });

  it('takes the previous max as the newest entry differing at two decimal places', () => {
    // 205.001 rounds to the current max, so 200 is still the previous one.
    const history = [...seeded.history, { lift: 'Squat', weight: 205.001, date: day('2026-02-15') }];
    expect(line({ ...seeded, history })).toBe('Training max 205 lbs. Last at 200 lbs: 8 reps.');
  });

  it('matches sets at exactly the previous weight', () => {
    const sets = [set({ weight: 200.5, reps: 2, date: day('2026-01-30') }), ...seeded.sets];
    expect(line({ ...seeded, sets })).toBe('Training max 205 lbs. Last at 200 lbs: 8 reps.');
  });

  it('writes the lifter’s preferred unit', () => {
    expect(line(seeded, 'kg')).toBe('Training max 92.99 kg. Last at 90.72 kg: 8 reps.');
  });

  it('says rep for a single rep', () => {
    const sets = [set({ weight: 200, reps: 1, date: day('2026-01-30') })];
    expect(line({ ...seeded, sets })).toBe('Training max 205 lbs. Last at 200 lbs: 1 rep.');
  });

  it('matches a set stored under the catalog id to a lift picked by name, and the reverse', () => {
    const sets = [set({ lift: 'back-squat', weight: 200, reps: 4, date: day('2026-01-30') }), ...seeded.sets];
    expect(line({ ...seeded, sets })).toBe('Training max 205 lbs. Last at 200 lbs: 4 reps.');
    const byId: NonCycleReferenceInput = {
      lift: 'back-squat',
      trainingMaxes: [{ lift: 'back-squat', weight: 205, dateUpdated: day('2026-02-01') }],
      history: seeded.history.map((entry) => ({ ...entry, lift: 'back-squat' })),
      sets: seeded.sets,
    };
    expect(line(byId)).toBe('Training max 205 lbs. Last at 200 lbs: 8 reps.');
  });

  describe('ties among sets at the previous weight', () => {
    const at = (fields: Partial<Set>) => set({ weight: 200, date: day('2026-01-30'), ...fields });
    const repsOf = (sets: Set[]) => line({ ...seeded, sets: [...sets].reverse() });

    it('go to the latest date', () => {
      expect(repsOf([at({ reps: 1, date: day('2026-01-29') }), at({ reps: 7 })])).toMatch(/: 7 reps\.$/);
    });

    it('then to the highest workout number', () => {
      expect(repsOf([at({ reps: 7, workoutNum: 3 }), at({ reps: 2, workoutNum: 2 })])).toMatch(/: 7 reps\.$/);
    });

    it('then to the lowest occurrence', () => {
      expect(repsOf([at({ reps: 7, occurrence: 0 }), at({ reps: 2, occurrence: 1 })])).toMatch(/: 7 reps\.$/);
    });

    it('then to the lowest set number', () => {
      expect(repsOf([at({ reps: 7, setNum: 1 }), at({ reps: 2, setNum: 2 })])).toMatch(/: 7 reps\.$/);
    });
  });
});
