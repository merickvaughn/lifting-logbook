jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchProgramSpec: jest.fn(),
  fetchTrainingMaxes: jest.fn(),
  fetchCustomLifts: jest.fn(),
  fetchFocusPlan: jest.fn(),
  // The progression reads (#1249). `getUserSettings` is the real request-cached wrapper over
  // `fetchUserSettings`, so a test can fail the read where the API would.
  fetchUserSettings: jest.fn(),
  fetchAllLiftMetadata: jest.fn(),
  fetchLiftRecords: jest.fn(),
}));

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('lbs'),
}));

// The user's calendar day, as the browser's time-zone cookie would give it (#1072).
jest.mock('@/lib/userToday', () => ({
  getUserToday: jest.fn().mockResolvedValue('2026-10-30'),
}));

import {
  fetchAllLiftMetadata,
  fetchCustomLifts,
  fetchFocusPlan,
  fetchLiftRecords,
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchUserSettings,
  fetchWorkout,
} from '@/lib/api';
import { CUSTOM_LIFTS_TIMEOUT_MS } from '@/lib/timerPlan';
import { loadProgressionPlans } from '@/lib/loadProgressionPlans';
import { FOCUS_PLAN_TIMEOUT_MS, loadFocusPlan, loadWorkoutPlan } from '@/lib/loadWorkoutPlan';
import { planLift } from '@/lib/workoutPlan';
import { focusPlan } from './focusPlanFixture';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedSpec = fetchProgramSpec as unknown as jest.Mock;
const mockedMaxes = fetchTrainingMaxes as unknown as jest.Mock;
const mockedCustomLifts = fetchCustomLifts as unknown as jest.Mock;
const mockedFocusPlan = fetchFocusPlan as unknown as jest.Mock;
const mockedUserSettings = fetchUserSettings as unknown as jest.Mock;
const mockedLiftMetadata = fetchAllLiftMetadata as unknown as jest.Mock;
const mockedLiftRecords = fetchLiftRecords as unknown as jest.Mock;

// Each row names its type, as every built-in preset's does, so a lift plans by its row and nothing
// reads the progression settings unless a test clears it (#1249).
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
    progression: 'amrap_gated' as const,
  };
}

/** A future-dated, unlogged workout — the state in which the timer is offered. */
function seedWorkout(lifts: string[], activation: Record<string, string> = {}, date = '2999-01-01') {
  mockedWorkout.mockResolvedValue({
    program: '5-3-1',
    macrocycleNum: 1,
    workoutNum: 1,
    week: 1,
    date,
    skipped: false,
    lifts: lifts.map((lift) => ({ lift, sets: [], planned: true })),
  });
  mockedSpec.mockResolvedValue(lifts.map((lift) => spec(lift, activation[lift] ?? '')));
  mockedMaxes.mockResolvedValue(lifts.map((lift) => ({ lift, weight: 200 })));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCustomLifts.mockResolvedValue([]);
  mockedUserSettings.mockResolvedValue({ defaultProgression: null, defaultWeightIncrement: null });
  mockedLiftMetadata.mockResolvedValue([]);
  mockedLiftRecords.mockResolvedValue([]);
});

describe('loadWorkoutPlan', () => {
  it('returns null for a workout the API does not have', async () => {
    mockedWorkout.mockResolvedValue(null);
    mockedSpec.mockResolvedValue([]);
    mockedMaxes.mockResolvedValue([]);

    await expect(loadWorkoutPlan('5-3-1', 99, 'WorkoutDetailPage')).resolves.toBeNull();
  });

  it('judges missed against the user’s calendar day, not the server’s', async () => {
    // A workout on the user's today is still upcoming, even once UTC has moved on (#1072).
    seedWorkout(['Squat'], {}, '2026-10-30');
    expect((await loadWorkoutPlan('5-3-1', 1, 'WorkoutDetailPage'))?.status).toBe('upcoming');

    seedWorkout(['Squat'], {}, '2026-10-29');
    expect((await loadWorkoutPlan('5-3-1', 1, 'WorkoutDetailPage'))?.status).toBe('missed');
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
    expect((await plan.timerLifts(null)).map((l) => [l.lift, l.sets.length])).toEqual([
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

  it('plans a week-2+ workout through the block week at its own day (issue #1014)', async () => {
    // The detail and timer pages both plan through this loader. The spec
    // endpoint serves only the stored block (every row week 1 here), so before
    // #1014 a week-2 workout found no rows and both pages planned no sets. Squat
    // also trains on day 2 with five sets, so the plan must come from this
    // workout's own day (offset 0, three sets), not just any Squat row.
    mockedWorkout.mockResolvedValue({
      program: 'leangains',
      macrocycleNum: 1,
      workoutNum: 4,
      week: 2,
      offset: 0,
      date: '2999-01-01',
      skipped: false,
      lifts: [{ lift: 'Squat', sets: [], planned: true }],
    });
    mockedSpec.mockResolvedValue([{ ...spec('Squat'), offset: 2, sets: 5 }, spec('Squat')]);
    mockedMaxes.mockResolvedValue([{ lift: 'Squat', weight: 200 }]);

    const plan = await loadWorkoutPlan('leangains', 4, 'WorkoutTimerPage');
    if (!plan) throw new Error('expected a plan');

    expect(plan.liftDetails.map((d) => [d.lift, d.warmUpCount, d.workCount])).toEqual([['Squat', 3, 3]]);
    expect((await plan.timerLifts(null)).map((l) => [l.lift, l.sets.length])).toEqual([['Squat', 6]]);
  });

  it('narrows the activation column once, keeping a movement and dropping a legacy marker', async () => {
    seedWorkout(['Squat', 'Bench Press'], { Squat: 'Hip Airplane', 'Bench Press': 'compound' });

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
    if (!plan) throw new Error('expected a plan');

    expect(plan.liftDetails.map((d) => d.activationMovement)).toEqual(['Hip Airplane', undefined]);
    expect((await plan.timerLifts(null)).map((l) => l.activation)).toEqual(['Hip Airplane', undefined]);
  });

  it('classifies built-ins from the catalog and the user’s own lifts from the fetched list', async () => {
    seedWorkout(['Squat', 'Cable Curls', 'Sissy Squat']);
    mockedCustomLifts.mockResolvedValue([{ name: 'Sissy Squat', classification: 'accessory' }]);

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
    if (!plan) throw new Error('expected a plan');

    expect((await plan.timerLifts(null)).map((l) => [l.lift, l.classification])).toEqual([
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
    expect((await plan.timerLifts(null)).map((l) => [l.lift, l.classification])).toEqual([
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

      const lifts = plan.timerLifts(null);
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
      const lifts = await plan?.timerLifts(null);
      expect(lifts?.map((l) => l.lift)).toEqual(['Squat']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('queues the focus plan it is handed with the planned lifts (#1060)', async () => {
    seedWorkout(['Squat']);
    mockedCustomLifts.mockResolvedValue([]);

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
    // Handed in flight, as the pages do, so it and the custom-lift budget run side by side.
    const lifts = await plan?.timerLifts(Promise.resolve(focusPlan()));

    expect(lifts?.map((l) => [l.lift, l.durations])).toEqual([
      ['Squat', undefined],
      ['Lateral Raise', { prep: 10, workSet: 45, restWork: 60 }],
      ['Face Pull', { prep: 10, workSet: 45, restWork: 60 }],
    ]);
  });
});

// The detail page and the timer plan each lift by its progression type, as the logger does (#1249).
describe('loadWorkoutPlan — the plan follows the lift’s progression type (#1249)', () => {
  const work = (sets: readonly { type: string; reps: number; weight: number }[] | undefined) =>
    sets?.filter((s) => s.type === 'work').map((s) => `${s.reps}@${s.weight}`);

  it('plans the Cable Curl double at 3×8 after the bump, the same plan the logger gives', async () => {
    // Range 8–12 at 30: 12,12,12 moved the max to 32.5 on that session's date, so the next plan
    // drops to the bottom of the range at the new max.
    seedWorkout(['Cable Curl']);
    const row = { ...spec('Cable Curl'), sets: 3, reps: 12, repsLow: 8, progression: 'double' as const, increment: 2.5, warmUpPct: '' };
    mockedSpec.mockResolvedValue([row]);
    const maxes = [{ lift: 'Cable Curl', weight: 32.5, dateUpdated: '2026-01-05T00:00:00.000Z' }];
    mockedMaxes.mockResolvedValue(maxes);
    // The workout carries the lift's last session, workout 4's (#1252).
    const lastSession = { date: '2026-01-05', reps: [12, 12, 12] };
    mockedWorkout.mockResolvedValue({
      program: '5-3-1',
      macrocycleNum: 1,
      workoutNum: 1,
      week: 1,
      date: '2999-01-01',
      skipped: false,
      lifts: [{ lift: 'Cable Curl', sets: [], planned: true, lastSession }],
    });

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutDetailPage');
    if (!plan) throw new Error('expected a plan');

    const [curl] = plan.liftDetails;
    expect(work(curl?.plannedSets)).toEqual(['8@32.5', '8@32.5', '8@32.5']);
    // The logger's plan for the same lift: its progression, through the same `planLift`.
    const [loggerProgression] = await loadProgressionPlans(plan.workout, [row], maxes, 'WorkoutLoggingPage');
    expect(loggerProgression?.lastSession).toEqual(lastSession);
    expect(curl?.plannedSets).toEqual(planLift(row, 32.5, { progression: loggerProgression }));
    // And the timer counts down the same sets.
    expect((await plan.timerLifts(null))[0]?.sets.map((s) => s.spec)).toEqual(['8 × 32.5 lbs', '8 × 32.5 lbs', '8 × 32.5 lbs']);
    // Nothing reads the macrocycle's records for it.
    expect(mockedLiftRecords).not.toHaveBeenCalled();
  });

  it('plans an off-program linear lift at its repsHigh, on the page and in the timer', async () => {
    seedWorkout(['Hammer Curl']);
    mockedSpec.mockResolvedValue([]);
    mockedLiftMetadata.mockResolvedValue([
      { lift: 'Hammer Curl', progression: 'linear', progressionIncrement: 2.5, repsLow: null, repsHigh: 10 },
    ]);

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutTimerPage');
    if (!plan) throw new Error('expected a plan');

    expect(work(plan.liftDetails[0]?.plannedSets)).toEqual(['10@200', '10@200', '10@200']);
    // Before #1249 a lift with no row planned nothing here, so the timer had no sets to count.
    const [hammer] = await plan.timerLifts(null);
    expect(hammer?.lift).toBe('Hammer Curl');
    expect(hammer?.sets).toHaveLength(3);
  });

  it('plans by the row, and says why under its own name, when the settings read fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    seedWorkout(['Squat']);
    // The row names no type, so the plan needs the lifter's settings.
    const row = { ...spec('Squat'), progression: undefined };
    mockedSpec.mockResolvedValue([row]);
    mockedUserSettings.mockRejectedValue(new Error('boom'));

    const plan = await loadWorkoutPlan('5-3-1', 1, 'WorkoutDetailPage');

    expect(plan?.liftDetails[0]?.plannedSets).toEqual(planLift(row, 200));
    expect(plan?.liftDetails[0]).toMatchObject({ warmUpCount: 3, workCount: 3 });
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutDetailPage] progression settings read failed, planning each lift by its row and the catalog',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('waits no longer than the custom-lift budget for a row with no type, and reads custom lifts once', async () => {
    // The progression read shares the timer's bounded custom-lift read, so a slow `/lifts/custom`
    // holds the page for the budget at most, not the api-client's 30 s, and is requested once.
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      seedWorkout(['Squat']);
      const row = { ...spec('Squat'), progression: undefined };
      mockedSpec.mockResolvedValue([row]);
      mockedCustomLifts.mockReturnValue(new Promise(() => undefined)); // never settles

      const loading = loadWorkoutPlan('5-3-1', 1, 'WorkoutDetailPage');
      // The budget arms in the same tick the settings read starts.
      for (let i = 0; i < 100 && mockedUserSettings.mock.calls.length === 0; i++) await Promise.resolve();
      jest.advanceTimersByTime(CUSTOM_LIFTS_TIMEOUT_MS + 1);
      const plan = await loading;

      expect(plan?.liftDetails[0]?.plannedSets).toEqual(planLift(row, 200));
      expect(warnSpy).toHaveBeenCalledWith('[WorkoutDetailPage] custom lifts fetch slow, classifying built-ins only');
      expect((await plan?.timerLifts(null))?.map((l) => l.lift)).toEqual(['Squat']);
      expect(mockedCustomLifts).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});

describe('loadFocusPlan (#1060)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the day’s focus plan, asked for the user’s calendar day', async () => {
    const plan = focusPlan();
    mockedFocusPlan.mockResolvedValueOnce(plan);

    await expect(loadFocusPlan('5-3-1', 1, 'WorkoutLoggingPage')).resolves.toEqual({ plan, failed: false });
    expect(mockedFocusPlan).toHaveBeenCalledWith('5-3-1', 1, '2026-10-30');
  });

  it('reads a plan with no active focus block as none', async () => {
    mockedFocusPlan.mockResolvedValueOnce(focusPlan({ groups: [] }));

    await expect(loadFocusPlan('5-3-1', 1, 'WorkoutDetailPage')).resolves.toEqual({ plan: null, failed: false });
  });

  it('degrades to no focus work, logged against its caller, when the fetch fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedFocusPlan.mockRejectedValueOnce(new Error('API down'));

    await expect(loadFocusPlan('5-3-1', 1, 'WorkoutTimerPage')).resolves.toEqual({ plan: null, failed: true });
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutTimerPage] focus plan fetch failed, showing planned lifts only',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('degrades to no focus work when the plan uses a placement or progression this build doesn’t know', async () => {
    // The API ships first; rendering this plan would throw in `workoutOrder`.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const plan = focusPlan();
    mockedFocusPlan.mockResolvedValueOnce({ ...plan, dayState: { ...plan.dayState, placement: 'sideways' } });

    await expect(loadFocusPlan('5-3-1', 1, 'WorkoutLoggingPage')).resolves.toEqual({ plan: null, failed: true });
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutLoggingPage] focus plan has a placement or progression this build doesn’t know, showing planned lifts only',
    );
    errSpy.mockRestore();
  });

  it('stops waiting for a slow focus plan after its budget', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockedFocusPlan.mockReturnValueOnce(new Promise(() => undefined));

      const loaded = loadFocusPlan('5-3-1', 1, 'WorkoutTimerPage');
      await jest.advanceTimersByTimeAsync(FOCUS_PLAN_TIMEOUT_MS);

      await expect(loaded).resolves.toEqual({ plan: null, failed: true });
      expect(warnSpy).toHaveBeenCalledWith('[WorkoutTimerPage] focus plan fetch slow, showing planned lifts only');
    } finally {
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
