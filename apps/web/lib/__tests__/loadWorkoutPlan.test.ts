jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchProgramSpec: jest.fn(),
  fetchTrainingMaxes: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('lbs'),
}));

import { fetchCustomLifts, fetchProgramSpec, fetchTrainingMaxes, fetchWorkout } from '@/lib/api';
import { CUSTOM_LIFTS_TIMEOUT_MS } from '@/lib/timerPlan';
import { loadWorkoutPlan } from '@/lib/loadWorkoutPlan';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedSpec = fetchProgramSpec as unknown as jest.Mock;
const mockedMaxes = fetchTrainingMaxes as unknown as jest.Mock;
const mockedCustomLifts = fetchCustomLifts as unknown as jest.Mock;

function spec(lift: string, activation = '') {
  return {
    week: 1,
    lift,
    order: 1,
    offset: 0,
    increment: 5,
    sets: 3,
    reps: 5,
    amrap: false,
    warmUpPct: '40,50,60',
    wtDecrementPct: 0,
    activation,
  };
}

/** A future-dated, unlogged workout — the state in which the timer is offered. */
function seedWorkout(lifts: string[], activation: Record<string, string> = {}) {
  mockedWorkout.mockResolvedValue({
    program: '5-3-1',
    cycleNum: 1,
    workoutNum: 1,
    week: 1,
    date: '2999-01-01',
    skipped: false,
    lifts: lifts.map((lift) => ({ lift, sets: [], planned: true })),
  });
  mockedSpec.mockResolvedValue(lifts.map((lift) => spec(lift, activation[lift] ?? '')));
  mockedMaxes.mockResolvedValue(lifts.map((lift) => ({ lift, weight: 200 })));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCustomLifts.mockResolvedValue([]);
});

describe('loadWorkoutPlan', () => {
  it('returns null for a workout the API does not have', async () => {
    mockedWorkout.mockResolvedValue(null);
    mockedSpec.mockResolvedValue([]);
    mockedMaxes.mockResolvedValue([]);

    await expect(loadWorkoutPlan('5-3-1', 99, 'WorkoutDetailPage')).resolves.toBeNull();
  });

  it('builds one detail per lift in order, keeping a lift the spec does not plan as an empty entry', async () => {
    // Squat is on the workout but has no spec row this week (an ad-hoc lift, or
    // an override the spec knows nothing about), so it plans no sets; a missing
    // training max, by contrast, still plans sets — at weight 0 — which is what
    // the page's "set a training max" prompt keys off.
    seedWorkout(['Squat', 'Cable Curls']);
    mockedSpec.mockResolvedValue([spec('Cable Curls')]);
    mockedMaxes.mockResolvedValue([{ lift: 'Cable Curls', weight: 60 }]);

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
    if (!plan) throw new Error('expected a plan');

    expect(plan.status).toBe('upcoming');
    expect(plan.liftDetails.map((d) => [d.lift, d.tm, d.plannedSets.length])).toEqual([
      ['Squat', 0, 0],
      ['Cable Curls', 60, 6],
    ]);
    expect(plan.liftDetails[1]).toMatchObject({ warmUpCount: 3, workCount: 3 });
    // Index-aligned with the details: the empty entry stays to hold its position.
    expect((await plan.timerLifts()).map((l) => [l.lift, l.sets.length])).toEqual([
      ['Squat', 0],
      ['Cable Curls', 6],
    ]);
  });

  it('still plans a lift with a spec row but no training max, at weight 0', async () => {
    // The sibling of the case above, and the reason that one seeds a missing
    // *spec row* rather than a missing max: the two are not interchangeable.
    // A lift the spec does not plan contributes no sets; a lift with no training
    // max still gets every set, priced at 0 — which is what the detail page's
    // "set a training max" prompt keys off. Asserting the weights, not just the
    // count, is what separates this from the empty-plan case.
    seedWorkout(['Squat']);
    mockedMaxes.mockResolvedValue([]);

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutDetailPage');
    if (!plan) throw new Error('expected a plan');

    const [squat] = plan.liftDetails;
    expect(squat).toMatchObject({ lift: 'Squat', tm: 0, warmUpCount: 3, workCount: 3 });
    expect(squat?.plannedSets.map((set) => set.weight)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('narrows the activation column once, keeping a movement and dropping a legacy marker', async () => {
    seedWorkout(['Squat', 'Bench Press'], { Squat: 'Hip Airplane', 'Bench Press': 'compound' });

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
    if (!plan) throw new Error('expected a plan');

    expect(plan.liftDetails.map((d) => d.activationMovement)).toEqual(['Hip Airplane', undefined]);
    expect((await plan.timerLifts()).map((l) => l.activation)).toEqual(['Hip Airplane', undefined]);
  });

  it('classifies built-ins from the catalog and the user’s own lifts from the fetched list', async () => {
    seedWorkout(['Squat', 'Cable Curls', 'Sissy Squat']);
    mockedCustomLifts.mockResolvedValue([{ name: 'Sissy Squat', classification: 'accessory' }]);

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
    if (!plan) throw new Error('expected a plan');

    expect((await plan.timerLifts()).map((l) => [l.lift, l.classification])).toEqual([
      ['Squat', 'compound'],
      ['Cable Curls', 'accessory'],
      ['Sissy Squat', 'accessory'],
    ]);
  });

  it('still classifies built-ins, and says so, when the custom-lift fetch fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    seedWorkout(['Squat', 'Cable Curls', 'Sissy Squat']);
    mockedCustomLifts.mockRejectedValue(new Error('API down'));

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
    if (!plan) throw new Error('expected a plan');

    // Paired with the success path above: a loader that stopped classifying
    // entirely would also "render", so assert the data, not just the resolve.
    // The honest cost of the fallback is the last row: the custom lift goes
    // unclassified and falls through to the preset — still in the session,
    // never dropped.
    expect((await plan.timerLifts()).map((l) => [l.lift, l.classification])).toEqual([
      ['Squat', 'compound'],
      ['Cable Curls', 'accessory'],
      ['Sissy Squat', undefined],
    ]);
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutTimerPage] custom lifts fetch failed, classifying built-ins only',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('gives up on a slow custom-lift fetch after the budget, distinctly from a failed one', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      seedWorkout(['Squat']);
      mockedCustomLifts.mockReturnValue(new Promise(() => undefined)); // never settles

      const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
      if (!plan) throw new Error('expected a plan');

      const lifts = plan.timerLifts();
      jest.advanceTimersByTime(CUSTOM_LIFTS_TIMEOUT_MS + 1);

      expect((await lifts).map((l) => [l.lift, l.classification])).toEqual([['Squat', 'compound']]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[WorkoutTimerPage] custom lifts fetch slow, classifying built-ins only',
      );
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('resolves the plan without waiting for the custom-lift fetch; only timerLifts() waits', async () => {
    // The detail page mounts the timer only for a timeable workout — most views
    // are of completed ones — so the optional enrichment must not sit on the
    // page's critical path. The fetch is started up front but awaited on demand.
    jest.useFakeTimers();
    try {
      seedWorkout(['Squat']);
      let settle: (lifts: { name: string; classification: 'accessory' }[]) => void = () => undefined;
      mockedCustomLifts.mockReturnValue(new Promise((resolve) => { settle = resolve; }));

      const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
      expect(plan).not.toBeNull();
      expect(mockedCustomLifts).toHaveBeenCalledTimes(1);

      settle([]);
      const lifts = await plan?.timerLifts();
      expect(lifts?.map((l) => l.lift)).toEqual(['Squat']);
    } finally {
      jest.useRealTimers();
    }
  });
});
