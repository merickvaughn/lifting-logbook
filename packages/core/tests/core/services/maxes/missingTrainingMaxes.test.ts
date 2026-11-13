import {
  estimateOneRepMax,
  estimateTrainingMax,
  floorToIncrement,
  missingTrainingMaxes,
  type MissingTrainingMaxesInput,
} from '@src/core';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Record = MissingTrainingMaxesInput['records'][number];
const set = (fields: Partial<Record>): Record => ({
  lift: 'Romanian Deadlift',
  weight: 100,
  reps: 5,
  date: day('2026-11-03'),
  ...fields,
});

const noModes = new Map();

describe('estimateTrainingMax (#1246)', () => {
  it("is onboarding's calculation on the best set: floorToIncrement(estimateOneRepMax(w, r) * 0.9)", () => {
    const estimate = estimateTrainingMax([set({ weight: 100, reps: 5 }), set({ weight: 90, reps: 5 })]);
    expect(estimate).toEqual({
      weight: floorToIncrement(estimateOneRepMax(100, 5) * 0.9),
      from: { date: day('2026-11-03'), weight: 100, reps: 5 },
    });
    // 100 × 5 estimates a 112.5 one-rep max, and 90% of that floors to 100.
    expect(estimate?.weight).toBe(100);
  });

  it('picks the set with the highest estimated one-rep max, not the heaviest', () => {
    // 100 × 10 estimates 137.5; 120 × 1 estimates 120.
    const estimate = estimateTrainingMax([set({ weight: 120, reps: 1 }), set({ weight: 100, reps: 10 })]);
    expect(estimate?.from).toMatchObject({ weight: 100, reps: 10 });
  });

  it('ignores a heavier set older than 8 weeks before the latest set', () => {
    const estimate = estimateTrainingMax([
      set({ weight: 300, reps: 5, date: day('2026-09-07') }), // 57 days before 3 Nov
      set({ weight: 100, reps: 5, date: day('2026-11-03') }),
    ]);
    expect(estimate?.from).toMatchObject({ weight: 100, date: day('2026-11-03') });
  });

  it('counts a set exactly 8 weeks before the latest set', () => {
    const estimate = estimateTrainingMax([
      set({ weight: 300, reps: 5, date: day('2026-09-08') }), // 56 days before 3 Nov
      set({ weight: 100, reps: 5, date: day('2026-11-03') }),
    ]);
    expect(estimate?.from).toMatchObject({ weight: 300 });
  });

  it('measures the window from the latest usable set, not from a zero-weight one', () => {
    const estimate = estimateTrainingMax([
      set({ weight: 200, reps: 5, date: day('2026-09-01') }),
      set({ weight: 0, reps: 5, date: day('2026-11-03') }),
    ]);
    expect(estimate?.from).toMatchObject({ weight: 200 });
  });

  it('returns null when every set has zero weight', () => {
    expect(estimateTrainingMax([set({ weight: 0 }), set({ weight: 0, reps: 8 })])).toBeNull();
  });

  it('leaves out sets with no reps or more reps than the formula covers', () => {
    expect(estimateTrainingMax([set({ reps: 0 }), set({ reps: 37 })])).toBeNull();
    expect(estimateTrainingMax([set({ weight: 300, reps: 37 }), set({ weight: 100, reps: 5 })])?.from.weight).toBe(100);
  });

  it('returns null when the estimate floors to nothing', () => {
    expect(estimateTrainingMax([set({ weight: 2.5, reps: 1 })])).toBeNull();
  });

  it('breaks a tie with the later set', () => {
    const estimate = estimateTrainingMax([
      set({ date: day('2026-11-01') }),
      set({ date: day('2026-11-03') }),
      set({ date: day('2026-11-02') }),
    ]);
    expect(estimate?.from.date).toEqual(day('2026-11-03'));
  });
});

describe('missingTrainingMaxes (#1246)', () => {
  const squatMax = { lift: 'Squat', dateUpdated: day('2026-10-01') };

  it('lists only the lifts with sets and no max', () => {
    const missing = missingTrainingMaxes({
      trainingMaxes: [squatMax],
      records: [set({}), set({ lift: 'Squat', weight: 300 })],
      modificationModes: noModes,
    });
    expect(missing).toEqual([
      {
        lift: 'Romanian Deadlift',
        liftId: 'romanian-deadlift',
        setCount: 1,
        lastLoggedDate: day('2026-11-03'),
        estimate: { weight: 100, from: { date: day('2026-11-03'), weight: 100, reps: 5 } },
      },
    ]);
  });

  it('finds a max stored under another spelling of the lift', () => {
    const missing = missingTrainingMaxes({
      trainingMaxes: [{ lift: 'romanian-deadlift', dateUpdated: day('2026-10-01') }],
      records: [set({})],
      modificationModes: noModes,
    });
    expect(missing).toEqual([]);
  });

  it('joins spellings of one lift into one row named as its latest set names it', () => {
    const missing = missingTrainingMaxes({
      trainingMaxes: [],
      records: [set({ lift: 'romanian-deadlift', date: day('2026-11-01') }), set({ date: day('2026-11-03') })],
      modificationModes: noModes,
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ lift: 'Romanian Deadlift', setCount: 2 });
  });

  it("leaves out a set under a modification that doesn't move the lift's max", () => {
    const modes = new Map([
      ['paused', 'none' as const],
      ['tempo', 'own' as const],
      ['belt', 'lift' as const],
    ]);
    const missing = missingTrainingMaxes({
      trainingMaxes: [],
      records: [
        set({ weight: 300, modifications: ['paused'] }),
        set({ weight: 280, modifications: ['tempo'] }),
        set({ weight: 100, modifications: ['belt'] }),
        set({ lift: 'Cable Curl', modifications: ['paused'] }),
      ],
      modificationModes: modes,
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ lift: 'Romanian Deadlift', setCount: 1, estimate: { from: { weight: 100 } } });
  });

  it('lists a lift with no usable set, with no estimate', () => {
    const missing = missingTrainingMaxes({
      trainingMaxes: [],
      records: [set({ lift: "Farmer's Carry", weight: 0 })],
      modificationModes: noModes,
    });
    expect(missing).toEqual([expect.objectContaining({ lift: "Farmer's Carry", setCount: 1, estimate: null })]);
  });

  it('orders the latest-logged lift first', () => {
    const missing = missingTrainingMaxes({
      trainingMaxes: [],
      records: [set({ lift: 'Cable Curl', date: day('2026-10-28') }), set({ date: day('2026-11-03') })],
      modificationModes: noModes,
    });
    expect(missing.map((m) => m.lift)).toEqual(['Romanian Deadlift', 'Cable Curl']);
  });
});
