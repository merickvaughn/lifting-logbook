import { BUILT_IN_KNOWN_PROGRAMS, LiftingProgramSpec, LiftRecord, TrainingMax } from '@lifting-logbook/core';
import { computeContinueMaxes, continueRefusal, parseContinue, plannedLifts } from './import-continue';

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
  const run = { program: '5-3-1', endDate: new Date('2026-03-10T00:00:00Z'), completedWorkouts: 3 };

  it('lets the last run of a known program continue with workouts left and a recent last session', () => {
    expect(continueRefusal(run, [new Date('2026-02-01T00:00:00Z')], context)).toBeNull();
  });

  it('refuses a run another stretch ends after', () => {
    expect(continueRefusal(run, [new Date('2026-03-11T00:00:00Z')], context)).toBe('not-last');
  });

  it('refuses a program with no known length', () => {
    expect(continueRefusal({ ...run, program: 'Custom' }, [], context)).toBe('unknown-program');
  });

  it('refuses a finished run', () => {
    expect(continueRefusal({ ...run, completedWorkouts: program.workoutCount }, [], context)).toBe('finished');
  });

  it('refuses a run whose last session is over 14 days old', () => {
    expect(continueRefusal(run, [], { ...context, importDate: new Date('2026-03-25T00:00:00Z') })).toBe('stale');
    expect(continueRefusal(run, [], { ...context, importDate: new Date('2026-03-24T00:00:00Z') })).toBeNull();
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
  });

  it.each([
    ['a non-object', 'x'],
    ['no stretch', { maxes: [] }],
    ['a negative stretch', { stretch: -1, maxes: [] }],
    ['no maxes', { stretch: 0 }],
    ['a zero weight', { stretch: 0, maxes: [{ lift: 'Back Squat', weight: 0 }] }],
    ['a non-numeric weight', { stretch: 0, maxes: [{ lift: 'Back Squat', weight: '230' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseContinue(value)).toThrow();
  });
});
