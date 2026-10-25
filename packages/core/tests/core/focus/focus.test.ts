import {
  FOCUS_AREAS,
  FOCUS_AREA_MUSCLES,
  MUSCLE_GROUPS,
  type FocusBlock,
  type FocusPoolEntry,
} from '@lifting-logbook/types';
import {
  blockRange,
  blockStatus,
  buildMuscleTargetResolver,
  daysLeft,
  expandRollovers,
  focusDurationSec,
  focusLiftCostSec,
  focusTrimKey,
  nextStart,
  planFocusDay,
  prescribe,
  rangeLabel,
  selectForDay,
  summarizeBlock,
  toIsoDate,
  type LiftRecord,
} from '@src/core';

// Local lift fixtures, declared as user overrides so these tests never depend on the
// built-in catalog's muscle data. Secondary muscles are listed to prove they don't count.
const resolveMuscles = buildMuscleTargetResolver([
  { lift: 'Fixture Squat', muscleGroups: ['Quads', 'Glutes'] },
  { lift: 'Fixture Overhead Press', muscleGroups: ['Front Delts'], secondaryMuscleGroups: ['Triceps'] },
  { lift: 'Fixture Bench', muscleGroups: ['Chest'], secondaryMuscleGroups: ['Triceps', 'Front Delts'] },
  { lift: 'Fixture Dips', muscleGroups: ['Chest', 'Triceps'] },
  { lift: 'Fixture Chin-up', muscleGroups: ['Lats'], secondaryMuscleGroups: ['Biceps'] },
]);

// A date-time with no offset parses as local time.
const day = (iso: string, hour = 0) => new Date(`${iso}T${String(hour).padStart(2, '0')}:00`);

function entry(lift: string, overrides: Partial<FocusPoolEntry> = {}): FocusPoolEntry {
  return {
    lift,
    include: 'auto',
    ruleLift: '',
    swapTo: '',
    sets: 3,
    repsLow: 10,
    repsHigh: 12,
    weight: 25,
    trainingMax: 40,
    percent: 65,
    rpe: 8,
    ...overrides,
  };
}

function block(overrides: Partial<FocusBlock> = {}): FocusBlock {
  return {
    id: 'sh',
    series: 's1',
    area: 'Shoulders',
    period: 'quarterly',
    align: 'calendar',
    start: '2026-10-01',
    selection: 'rules',
    overlap: 'anyway',
    progression: 'double',
    priority: 1,
    timer: { prep: 10, set: 45, rest: 60 },
    onEnd: 'prompt',
    nextArea: null,
    pool: [entry('Lateral Raise'), entry('Upright Row'), entry('Face Pull')],
    ...overrides,
  };
}

describe('focus areas', () => {
  it('maps every area onto MUSCLE_GROUPS', () => {
    const vocabulary = new Set<string>(MUSCLE_GROUPS);
    for (const area of FOCUS_AREAS) {
      expect(FOCUS_AREA_MUSCLES[area].length).toBeGreaterThan(0);
      for (const muscle of FOCUS_AREA_MUSCLES[area]) expect(vocabulary.has(muscle)).toBe(true);
    }
    expect(FOCUS_AREA_MUSCLES.Shoulders).toEqual(['Front Delts', 'Side Delts', 'Rear Delts']);
    expect(FOCUS_AREA_MUSCLES.Back).toEqual(['Lats', 'Upper Back', 'Traps', 'Lower Back']);
  });
});

describe('block dates', () => {
  const iso = (b: Parameters<typeof blockRange>[0]) => {
    const { start, end } = blockRange(b);
    return [toIsoDate(start), toIsoDate(end)];
  };

  it('snaps a calendar quarter to the quarter containing the start', () => {
    const b = { start: '2026-11-15', period: 'quarterly', align: 'calendar' } as const;
    expect(iso(b)).toEqual(['2026-10-01', '2026-12-31']);
    expect(rangeLabel(b)).toBe('Q4 2026');
    expect(nextStart(b)).toBe('2027-01-01');
  });

  it('snaps a calendar month to the month containing the start', () => {
    const b = { start: '2026-02-12', period: 'monthly', align: 'calendar' } as const;
    expect(iso(b)).toEqual(['2026-02-01', '2026-02-28']);
    expect(rangeLabel(b)).toBe('February 2026');
    expect(nextStart(b)).toBe('2026-03-01');
  });

  it('runs a custom month from its start date across a year boundary', () => {
    const b = { start: '2026-12-12', period: 'monthly', align: 'custom' } as const;
    expect(iso(b)).toEqual(['2026-12-12', '2027-01-11']);
    expect(rangeLabel(b)).toBe('Dec 12 – Jan 11');
    expect(nextStart(b)).toBe('2027-01-12');
  });

  it('runs a custom quarter from its start date across a year boundary', () => {
    const b = { start: '2026-11-20', period: 'quarterly', align: 'custom' } as const;
    expect(iso(b)).toEqual(['2026-11-20', '2027-02-19']);
    expect(rangeLabel(b)).toBe('Nov 20 – Feb 19');
  });

  it('counts days left to the last day, ignoring the time of day', () => {
    const b = block();
    expect(daysLeft(b, day('2026-10-23'))).toBe(69);
    expect(daysLeft(b, day('2026-10-23', 15))).toBe(69);
    expect(daysLeft(b, day('2026-12-31'))).toBe(0);
    expect(daysLeft(b, day('2027-01-02'))).toBe(-2);
  });

  it('derives status from dates, inclusive at both ends', () => {
    const b = block();
    expect(blockStatus(b, day('2026-09-30', 23))).toBe('queued');
    expect(blockStatus(b, day('2026-10-01'))).toBe('active');
    expect(blockStatus(b, day('2026-12-31', 23))).toBe('active');
    expect(blockStatus(b, day('2027-01-01'))).toBe('ended');
  });
});

describe('expandRollovers', () => {
  const rolling = block({ onEnd: 'autoroll', nextArea: 'Back' });

  it('creates the successor of an active auto-roll block', () => {
    const poolFor = jest.fn(() => [entry('Lat Pulldown')]);
    const successors = expandRollovers([rolling], day('2026-10-23'), poolFor);
    expect(poolFor).toHaveBeenCalledWith('Back');
    expect(successors).toEqual([
      {
        ...rolling,
        id: 'roll-sh',
        area: 'Back',
        start: '2027-01-01',
        onEnd: 'prompt',
        nextArea: null,
        pool: [entry('Lat Pulldown')],
      },
    ]);
    expect(successors.map((s) => blockStatus(s, day('2026-10-23')))).toEqual(['queued']);
  });

  it('defaults the successor pool to empty', () => {
    expect(expandRollovers([rolling], day('2026-10-23')).map((s) => s.pool)).toEqual([[]]);
  });

  it('still creates the successor once the block has ended', () => {
    expect(expandRollovers([rolling], day('2027-02-01'))).toHaveLength(1);
  });

  it('is idempotent once the successor exists', () => {
    const successors = expandRollovers([rolling], day('2026-10-23'));
    expect(expandRollovers([rolling, ...successors], day('2026-10-23'))).toEqual([]);
  });

  it('skips blocks that prompt, have no next area, or have not started', () => {
    expect(expandRollovers([block({ onEnd: 'prompt', nextArea: 'Back' })], day('2026-10-23'))).toEqual([]);
    expect(expandRollovers([block({ onEnd: 'autoroll', nextArea: null })], day('2026-10-23'))).toEqual([]);
    expect(expandRollovers([rolling], day('2026-09-15'))).toEqual([]);
  });

  it('only counts later blocks in the same series as the successor', () => {
    const otherSeries = block({ id: 'x', series: 's9', start: '2027-01-01' });
    const earlier = block({ id: 'old', start: '2026-07-01' });
    expect(expandRollovers([rolling, otherSeries, earlier], day('2026-10-23'))).toHaveLength(1);
  });
});

describe('selectForDay', () => {
  const lifts = (items: { lift: string }[]) => items.map((item) => item.lift);

  it('Rules selects every eligible lift, never off or swap-only lifts', () => {
    const b = block({
      pool: [entry('A'), entry('B', { include: 'off' }), entry('C', { include: 'swap' }), entry('D', { include: 'always' })],
    });
    const result = selectForDay(b, ['Fixture Squat'], 0, undefined, resolveMuscles);
    expect(lifts(result.items)).toEqual(['A', 'D']);
    expect(result).toMatchObject({ skipped: [], suggestions: [], overlap: null, mode: 'rules' });
  });

  it('applies a rule lift only when its rule lift is planned', () => {
    const b = block({ pool: [entry('A', { include: 'rule', ruleLift: 'Fixture Squat' }), entry('B')] });
    const planned = selectForDay(b, ['Fixture Squat'], 0, undefined, resolveMuscles);
    expect(lifts(planned.items)).toEqual(['B']);
    expect(planned.skipped).toEqual([{ lift: 'A', reason: 'rule', detail: 'Fixture Squat' }]);
    expect(lifts(selectForDay(b, ['Fixture Chin-up'], 0, undefined, resolveMuscles).items)).toEqual(['A', 'B']);
  });

  it('treats a rule lift with no rule lift set as eligible', () => {
    const b = block({ pool: [entry('A', { include: 'rule' })] });
    expect(lifts(selectForDay(b, [], 0, undefined, resolveMuscles).items)).toEqual(['A']);
  });

  it('Rotate cycles one flex lift by workout index, with Always lifts on top', () => {
    const b = block({ selection: 'rotate', pool: [entry('A'), entry('B'), entry('C', { include: 'always' })] });
    const on = (dayIndex: number) => selectForDay(b, [], dayIndex, undefined, resolveMuscles);
    expect(lifts(on(0).items)).toEqual(['C', 'A']);
    expect(lifts(on(1).items)).toEqual(['C', 'B']);
    expect(lifts(on(2).items)).toEqual(['C', 'A']);
    expect(on(1).skipped).toEqual([{ lift: 'A', reason: 'rotation', detail: '' }]);
  });

  it('Rotate with only Always lifts selects just those', () => {
    const b = block({ selection: 'rotate', pool: [entry('C', { include: 'always' })] });
    expect(lifts(selectForDay(b, [], 1, undefined, resolveMuscles).items)).toEqual(['C']);
  });

  it('Fixed uses the first flex lift every workout', () => {
    const b = block({ selection: 'fixed', pool: [entry('A'), entry('B'), entry('C', { include: 'always' })] });
    const result = selectForDay(b, [], 2, undefined, resolveMuscles);
    expect(lifts(result.items)).toEqual(['C', 'A']);
    expect(result.skipped).toEqual([{ lift: 'B', reason: 'fixed', detail: 'A' }]);
    const alwaysOnly = block({ selection: 'fixed', pool: [entry('C', { include: 'always' })] });
    expect(lifts(selectForDay(alwaysOnly, [], 0, undefined, resolveMuscles).items)).toEqual(['C']);
  });

  it('I pick offers the flex lifts and selects the picks plus Always lifts', () => {
    const b = block({ selection: 'pick', pool: [entry('A'), entry('B'), entry('C', { include: 'always' })] });
    const unpicked = selectForDay(b, [], 0, undefined, resolveMuscles);
    expect(lifts(unpicked.items)).toEqual(['C']);
    expect(lifts(unpicked.suggestions)).toEqual(['A', 'B']);
    const picked = selectForDay(b, [], 0, { modes: {}, picks: { sh: ['B'] } }, resolveMuscles);
    expect(lifts(picked.items)).toEqual(['B', 'C']);
  });

  it('a day mode override replaces the block selection', () => {
    const b = block({ selection: 'rules', pool: [entry('A'), entry('B')] });
    const result = selectForDay(b, [], 0, { modes: { sh: 'fixed' }, picks: {} }, resolveMuscles);
    expect(result.mode).toBe('fixed');
    expect(lifts(result.items)).toEqual(['A']);
  });

  it('detects overlap from primary muscles only', () => {
    const triceps = block({ area: 'Triceps', overlap: 'skip', pool: [entry('Pushdown')] });
    expect(selectForDay(triceps, ['Fixture Bench'], 0, undefined, resolveMuscles).overlap).toBeNull();
    expect(selectForDay(triceps, ['Fixture Bench', 'Fixture Dips'], 0, undefined, resolveMuscles).overlap).toEqual({
      lifts: ['Fixture Dips'],
      mode: 'skip',
    });
  });

  it('detects overlap through a user override', () => {
    const calves = block({ area: 'Calves', overlap: 'skip', pool: [entry('Calf Raise')] });
    const overridden = buildMuscleTargetResolver([{ lift: 'Fixture Squat', muscleGroups: ['Quads', 'Calves'] }]);
    expect(selectForDay(calves, ['Fixture Squat'], 0, undefined, resolveMuscles).items).toHaveLength(1);
    expect(selectForDay(calves, ['Fixture Squat'], 0, undefined, overridden).items).toEqual([]);
  });

  it('Skip drops every lift and names the overlapping planned lifts', () => {
    const b = block({ overlap: 'skip', pool: [entry('A'), entry('B')] });
    const planned = ['Fixture Overhead Press', 'Fixture Squat', 'Fixture Overhead Press'];
    const result = selectForDay(b, planned, 0, undefined, resolveMuscles);
    expect(result.items).toEqual([]);
    expect(result.skipped).toEqual([
      { lift: 'A', reason: 'overlap', detail: 'Fixture Overhead Press & Fixture Overhead Press' },
      { lift: 'B', reason: 'overlap', detail: 'Fixture Overhead Press & Fixture Overhead Press' },
    ]);
  });

  it('Reduce takes one set off each lift, never below one', () => {
    const b = block({ overlap: 'reduce', pool: [entry('A', { sets: 3 }), entry('B', { sets: 1 })] });
    const result = selectForDay(b, ['Fixture Overhead Press'], 0, undefined, resolveMuscles);
    expect(result.items.map(({ lift, sets, reducedFrom }) => ({ lift, sets, reducedFrom }))).toEqual([
      { lift: 'A', sets: 2, reducedFrom: 3 },
      { lift: 'B', sets: 1, reducedFrom: 1 },
    ]);
  });

  it('Swap replaces lifts with their swap targets and de-duplicates', () => {
    const b = block({
      overlap: 'swap',
      pool: [
        entry('A', { swapTo: 'Face Pull' }),
        entry('B', { swapTo: 'Face Pull' }),
        entry('C'),
        entry('D', { swapTo: 'Missing' }),
        entry('Face Pull', { include: 'swap', sets: 4 }),
      ],
    });
    const result = selectForDay(b, ['Fixture Overhead Press'], 0, undefined, resolveMuscles);
    expect(result.items.map(({ lift, sets, swappedFrom }) => ({ lift, sets, swappedFrom }))).toEqual([
      { lift: 'Face Pull', sets: 4, swappedFrom: 'A' },
      { lift: 'C', sets: 3, swappedFrom: undefined },
      { lift: 'D', sets: 3, swappedFrom: undefined },
    ]);
  });

  it('Do it anyway keeps the full prescription but reports the overlap', () => {
    const b = block({ overlap: 'anyway', pool: [entry('A')] });
    const result = selectForDay(b, ['Fixture Overhead Press'], 0, undefined, resolveMuscles);
    expect(result.items).toEqual([{ entry: b.pool[0], lift: 'A', sets: 3 }]);
    expect(result.overlap).toEqual({ lifts: ['Fixture Overhead Press'], mode: 'anyway' });
  });
});

describe('focus timing', () => {
  const timer = { prep: 10, set: 45, rest: 60 };

  it('times sets with a rest between each, and charges one extra rest per lift', () => {
    expect(focusDurationSec(3, timer)).toBe(3 * 55 + 2 * 60);
    expect(focusDurationSec(1, timer)).toBe(55);
    expect(focusDurationSec(0, timer)).toBe(0);
    expect(focusLiftCostSec(3, timer)).toBe(285 + 60);
  });
});

describe('planFocusDay', () => {
  const today = day('2026-10-23');
  const shoulders = block({ id: 'sh', priority: 1, pool: [entry('Lateral Raise'), entry('Upright Row')] });
  const biceps = block({ id: 'bi', area: 'Biceps', priority: 2, pool: [entry('Hammer Curl'), entry('Cable Curl')] });
  const queued = block({ id: 'q', area: 'Core', priority: 0, start: '2027-01-01' });
  const ended = block({ id: 'e', area: 'Chest', priority: 0, start: '2026-07-01' });
  const base = { plannedLifts: [], dayIndex: 0, today, resolveMuscles };

  it('plans active blocks only, highest priority first, with totals', () => {
    const plan = planFocusDay({ ...base, blocks: [biceps, queued, shoulders, ended], budget: { sets: 20, minutes: 60 } });
    expect(plan.groups.map((g) => g.block.id)).toEqual(['sh', 'bi']);
    expect(plan.sets).toBe(12);
    expect(plan.seconds).toBe(4 * 345);
    expect(plan.over).toBe(false);
    expect(plan.suggestion).toBeNull();
  });

  it('suggests trimming the last lift of the lowest-priority block when over on sets', () => {
    const plan = planFocusDay({ ...base, blocks: [shoulders, biceps], budget: { sets: 9, minutes: 60 } });
    expect(plan.over).toBe(true);
    expect(plan.suggestion).toEqual({ blockId: 'bi', lift: 'Cable Curl', sets: 9, seconds: 3 * 345 });
  });

  it('is over on minutes alone', () => {
    const plan = planFocusDay({ ...base, blocks: [shoulders], budget: { sets: 20, minutes: 11 } });
    expect(plan.seconds / 60).toBeCloseTo(11.5);
    expect(plan.over).toBe(true);
  });

  it('skips past a lowest-priority block with nothing left', () => {
    const triceps = block({ id: 'tri', area: 'Triceps', priority: 2, overlap: 'skip', pool: [entry('Pushdown')] });
    const plan = planFocusDay({
      ...base,
      plannedLifts: ['Fixture Dips'],
      blocks: [shoulders, triceps],
      budget: { sets: 1, minutes: 60 },
    });
    expect(plan.suggestion).toMatchObject({ blockId: 'sh', lift: 'Upright Row', sets: 3 });
  });

  it('applies trims before totalling', () => {
    const plan = planFocusDay({
      ...base,
      blocks: [shoulders, biceps],
      dayState: { modes: {}, picks: {}, trims: [focusTrimKey('bi', 'Cable Curl')] },
      budget: { sets: 9, minutes: 60 },
    });
    expect(plan.groups[1]?.trimmed).toEqual(['Cable Curl']);
    expect(plan.groups[1]?.selection.items.map((i) => i.lift)).toEqual(['Hammer Curl']);
    expect(plan.sets).toBe(9);
    expect(plan.over).toBe(false);
  });
});

describe('prescribe', () => {
  const pool = entry('Lateral Raise', { repsLow: 12, repsHigh: 15, weight: 27.3, trainingMax: 95, percent: 65, rpe: 8.5 });

  it('double progression keeps the rep range, weight as entered, and last reps', () => {
    expect(prescribe({ progression: 'double' }, { ...pool, lastReps: [15, 14] }, 3)).toEqual({
      progression: 'double',
      sets: 3,
      repsLow: 12,
      repsHigh: 15,
      weight: 27.3,
      lastReps: [15, 14],
    });
    expect(prescribe({ progression: 'double' }, pool, 3)).toMatchObject({ lastReps: null });
  });

  it('fixed never rounds the entered weight', () => {
    expect(prescribe({ progression: 'fixed' }, pool, 2)).toEqual({ progression: 'fixed', sets: 2, reps: 15, weight: 27.3 });
  });

  it('percent of training max rounds to a loadable plate increment', () => {
    // 65% of 95 = 61.75
    expect(prescribe({ progression: 'tm' }, pool, 3)).toEqual({
      progression: 'tm',
      sets: 3,
      reps: 15,
      weight: 62.5,
      percent: 65,
      trainingMax: 95,
    });
    expect(prescribe({ progression: 'tm' }, pool, 3, 5)).toMatchObject({ weight: 60 });
  });

  it('RPE reports reps in reserve', () => {
    expect(prescribe({ progression: 'rpe' }, pool, 4)).toEqual({ progression: 'rpe', sets: 4, reps: 15, rpe: 8.5, repsInReserve: 1.5 });
  });
});

describe('summarizeBlock', () => {
  const record = (lift: string, iso: string, weight: number, reps: number): LiftRecord => ({
    program: 'p',
    macrocycleNum: 1,
    workoutNum: 1,
    date: day(iso, 18),
    lift,
    setNum: 1,
    weight,
    reps,
    notes: '',
  });
  const b = block({ period: 'monthly', start: '2026-09-01', pool: [entry('Hammer Curl'), entry('Cable Curl'), entry('New Lift'), entry('Flat Lift')] });

  it('totals pool-lift sets inside the range and finds PRs against the best before it', () => {
    const summary = summarizeBlock(
      [
        record('Hammer Curl', '2026-08-20', 35, 12),
        record('Hammer Curl', '2026-09-03', 40, 10),
        record('Hammer Curl', '2026-09-03', 40, 8),
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

  it('is empty with no records', () => {
    expect(summarizeBlock([], b)).toEqual({ sessions: 0, sets: 0, volume: 0, prs: [] });
  });
});
