import { BUILT_IN_KNOWN_PROGRAMS, LiftingProgramSpec, LiftRecord, TrainingMax } from '@lifting-logbook/core';
import { emptyFocusDayState } from '@lifting-logbook/types';
import { InMemoryRepositoryFactory } from '../adapters/factory/in-memory-repository-factory';
import { computeContinueMaxes, continueRefusal, parseContinue, plannedLifts, recreateRemovedLive } from './import-continue';

// The computed maxes a continued run offers (#1180, proposal decision 10), and which runs may
// continue (decision 2).

// An unregistered program, so its workouts number the spec's days.
const OPTIONS = {
  program: 'Custom',
  liftOverrides: new Map(),
  modificationModes: new Map(),
  modificationMaxes: [],
};

const row = (lift: string, fields: Partial<LiftingProgramSpec> = {}): LiftingProgramSpec => ({
  week: 1,
  offset: 0,
  lift,
  increment: 5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: '',
  wtDecrementPct: 0,
  activation: '',
  progression: 'amrap_gated',
  ...fields,
});

/** One session: a set per entry of `reps`, all at `weight`. */
const session = (lift: string, date: string, weight: number, reps: number[]): LiftRecord[] =>
  reps.map((r, i) => ({
    program: 'Custom',
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date(date),
    lift,
    setNum: i + 1,
    weight,
    reps: r,
    notes: '',
  }));

const max = (lift: string, weight: number, date = '2026-01-01'): TrainingMax => ({ lift, weight, dateUpdated: new Date(date) });

const SPEC = [row('Back Squat'), row('Bench Press', { order: 2 })];

describe('computeContinueMaxes (#1180)', () => {
  it('returns a value per lift for a program with no maxes at all, rather than throwing', () => {
    const run = [...session('Back Squat', '2026-03-02', 225, [5, 5, 8]), ...session('Bench Press', '2026-03-02', 155, [5, 5, 6])];
    expect(computeContinueMaxes(SPEC, [], run, OPTIONS)).toEqual([
      { lift: 'Back Squat', current: null, computed: 230 },
      { lift: 'Bench Press', current: null, computed: 160 },
    ]);
  });

  it('gives a lift with no qualifying set no value', () => {
    // Set 1 misses the target, so nothing moves the bench max, stored or not.
    const run = [...session('Back Squat', '2026-03-02', 225, [5, 5, 5]), ...session('Bench Press', '2026-03-02', 155, [3, 3, 3])];
    expect(computeContinueMaxes(SPEC, [max('Back Squat', 200)], run, OPTIONS)).toEqual([
      { lift: 'Back Squat', current: 200, computed: 230 },
      { lift: 'Bench Press', current: null, computed: null },
    ]);
  });

  it('reads a lower value from flagged', () => {
    // 200 + 5 is below the stored 300, which updateMaxes flags rather than applies.
    const run = session('Back Squat', '2026-03-02', 200, [5, 5, 5]);
    expect(computeContinueMaxes(SPEC, [max('Back Squat', 300), max('Bench Press', 150)], run, OPTIONS)).toEqual([
      { lift: 'Back Squat', current: 300, computed: 205 },
      { lift: 'Bench Press', current: 150, computed: null },
    ]);
  });

  it('keeps the stored spelling of a lift', () => {
    const run = session('Back Squat', '2026-03-02', 225, [5, 5, 5]);
    expect(computeContinueMaxes(SPEC, [max('Squat', 200)], run, OPTIONS)[0]).toEqual({
      lift: 'Squat',
      current: 200,
      computed: 230,
    });
  });
});

describe('plannedLifts', () => {
  it('lists each lift once, in spec order', () => {
    expect(plannedLifts([row('Back Squat'), row('Bench Press'), row('Squat', { week: 2 })])).toEqual(['Back Squat', 'Bench Press']);
  });
});

describe('continueRefusal (#1180, decision 2)', () => {
  const program = BUILT_IN_KNOWN_PROGRAMS.find((p) => p.id === '5-3-1');
  if (!program) throw new Error('5-3-1 is a built-in program');
  const context = { programs: BUILT_IN_KNOWN_PROGRAMS, importDate: new Date('2026-03-20T00:00:00Z') };
  const run = {
    program: '5-3-1',
    startDate: new Date('2026-03-02T00:00:00Z'),
    endDate: new Date('2026-03-10T00:00:00Z'),
    completedWorkouts: 3,
    placement: 'new' as const,
    someStored: false,
  };
  const stretch = (program: string, start: string, end: string) => ({
    program,
    startDate: new Date(`${start}T00:00:00Z`),
    endDate: new Date(`${end}T00:00:00Z`),
  });

  it('lets the last run of a known program continue with workouts left and a recent last session', () => {
    expect(continueRefusal(run, [stretch('5-3-1', '2026-01-05', '2026-02-01')], [new Date('2026-02-01T00:00:00Z')], context)).toBeNull();
  });

  it('refuses a run with stored rows, or overlapping a stored macrocycle', () => {
    expect(continueRefusal({ ...run, placement: 'already-imported' }, [], [], context)).toBe('already-stored');
    expect(continueRefusal({ ...run, placement: 'joins' }, [], [], context)).toBe('already-stored');
    expect(continueRefusal({ ...run, placement: 'overlaps' }, [], [], context)).toBe('overlaps');
  });

  it('refuses a run some of whose sets are stored, as non-cycle workouts or anywhere else', () => {
    expect(continueRefusal({ ...run, someStored: true }, [], [], context)).toBe('already-stored');
  });

  it("refuses a run overlapping another of the file's stretches in its program, though that one ends first", () => {
    expect(continueRefusal(run, [stretch('5-3-1', '2026-02-20', '2026-03-03')], [], context)).toBe('overlaps');
    // Another program's stretch on the same days numbers apart, so it doesn't interleave.
    expect(continueRefusal(run, [stretch('rpt', '2026-02-20', '2026-03-03')], [], context)).toBeNull();
  });

  it('refuses a run another stretch or a stored macrocycle ends after', () => {
    expect(continueRefusal(run, [stretch('rpt', '2026-03-11', '2026-03-11')], [], context)).toBe('not-last');
    expect(continueRefusal(run, [], [new Date('2026-03-11T00:00:00Z')], context)).toBe('not-last');
  });

  it('refuses a program with no known length', () => {
    expect(continueRefusal({ ...run, program: 'Custom' }, [], [], context)).toBe('unknown-program');
  });

  it('refuses a finished run', () => {
    expect(continueRefusal({ ...run, completedWorkouts: program.workoutCount }, [], [], context)).toBe('finished');
  });

  it('refuses a run whose last session is over 14 days old', () => {
    expect(continueRefusal(run, [], [], { ...context, importDate: new Date('2026-03-25T00:00:00Z') })).toBe('stale');
    expect(continueRefusal(run, [], [], { ...context, importDate: new Date('2026-03-24T00:00:00Z') })).toBeNull();
  });
});

describe('parseContinue', () => {
  it('reads a continue choice', () => {
    expect(parseContinue({ stretch: 1, endLive: 'm1', maxes: [{ lift: 'Back Squat', weight: 230 }] })).toEqual({
      stretch: 1,
      endLive: 'm1',
      maxes: [{ lift: 'Back Squat', weight: 230 }],
    });
    expect(parseContinue(undefined)).toBeUndefined();
    expect(parseContinue({ stretch: 0, removeLive: 'm2', maxes: [] })).toEqual({ stretch: 0, removeLive: 'm2', maxes: [] });
  });

  it.each([
    ['a non-object', 'x'],
    ['a removeLive that is no id', { stretch: 0, removeLive: 2, maxes: [] }],
    ['no stretch', { maxes: [] }],
    ['a negative stretch', { stretch: -1, maxes: [] }],
    ['no maxes', { stretch: 0 }],
    ['a zero weight', { stretch: 0, maxes: [{ lift: 'Back Squat', weight: 0 }] }],
    ['a non-numeric weight', { stretch: 0, maxes: [{ lift: 'Back Squat', weight: '230' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseContinue(value)).toThrow();
  });
});

describe('recreateRemovedLive (#1354)', () => {
  it('takes the number after the highest macrocycle, moving a row there with no macrocycle past it', async () => {
    const repos = await new InMemoryRepositoryFactory().forUser({ id: 'recreate-removed', email: 'r@example.com', provider: 'dev' });
    const day = (d: string) => new Date(`${d}T00:00:00Z`);
    for (const [num, start] of [[1, '2025-01-06'], [2, '2025-03-03']] as const) {
      await repos.macrocycle.create({ program: 'rpt', macrocycleNum: num, startDate: day(start), status: 'completed', origin: 'imported' });
    }
    // A focus state saved before the next macrocycle starts, on the number after the highest.
    await repos.focus.saveDayState('rpt', 3, 1, { ...emptyFocusDayState(), dismissed: true });

    await recreateRemovedLive(repos, 'rpt', {
      id: 'removed-live',
      startDate: '2025-05-05',
      endDate: null,
      status: 'in-progress',
      statusChosen: false,
      origin: 'live',
      unmatched: false,
      importedThrough: null,
      schedule: [{ workoutNum: 1, weekNum: 1, scheduledDate: '2025-05-05T00:00:00.000Z' }],
      dateOverrides: [],
      skips: [],
      liftOverrides: [],
      focus: [],
    });

    expect(await repos.macrocycle.findById('removed-live')).toMatchObject({ macrocycleNum: 3, startDate: day('2025-05-05') });
    expect(await repos.macrocycleScheduledWorkout.getScheduledWorkouts('rpt', 3)).toHaveLength(1);
    // The focus state still belongs to the next macrocycle to start, not the recreated one.
    expect(await repos.focus.getDayState('rpt', 3, 1)).toBeNull();
    expect(await repos.focus.getDayState('rpt', 4, 1)).toMatchObject({ dismissed: true });
  });
});
