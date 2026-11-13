import type { LiftingProgramSpecResponse } from '@lifting-logbook/types';
import {
  buildLiftDetails,
  buildWorkoutDays,
  computeMacrocycleProgress,
  computePlannedSets,
  planLift,
  workoutDateResolver,
} from '../workoutPlan';
import type { WeekRow, WorkoutCell, WorkoutLiftDetail } from '../workoutPlan';

const makeSpec = (
  overrides: Partial<LiftingProgramSpecResponse>,
): LiftingProgramSpecResponse => ({
  week: 1,
  lift: 'Squat',
  order: 1,
  offset: 0,
  increment: 5,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0,
  activation: '',
  ...overrides,
});

describe('buildWorkoutDays', () => {
  it('groups specs by offset and assigns workoutNum 1-based in offset order', () => {
    const specs: LiftingProgramSpecResponse[] = [
      makeSpec({ lift: 'Squat', offset: 0, order: 1 }),
      makeSpec({ lift: 'Bench Press', offset: 0, order: 2 }),
      makeSpec({ lift: 'Deadlift', offset: 2, order: 1 }),
    ];

    const days = buildWorkoutDays(specs, '2026-01-05');

    expect(days).toHaveLength(2);
    expect(days[0]?.workoutNum).toBe(1);
    expect(days[0]?.lifts.map((l) => l.lift)).toEqual(['Squat', 'Bench Press']);
    expect(days[1]?.workoutNum).toBe(2);
    expect(days[1]?.lifts.map((l) => l.lift)).toEqual(['Deadlift']);
  });

  it('sources week from the first lift in each offset group', () => {
    const specs: LiftingProgramSpecResponse[] = [
      makeSpec({ offset: 0, week: 1 }),
      makeSpec({ lift: 'Bench Press', offset: 0, week: 1 }),
      makeSpec({ lift: 'Deadlift', offset: 7, week: 2 }),
    ];

    const days = buildWorkoutDays(specs, '2026-01-05');

    expect(days[0]?.week).toBe(1);
    expect(days[1]?.week).toBe(2);
  });

  it('computes workout dates by adding offset days to macrocycleStartDate in UTC', () => {
    const specs = [
      makeSpec({ offset: 0 }),
      makeSpec({ lift: 'Bench Press', offset: 3 }),
    ];

    const days = buildWorkoutDays(specs, '2026-01-05');

    expect(days[0]?.date).toBe('2026-01-05');
    expect(days[1]?.date).toBe('2026-01-08');
  });

  it('sorts lifts within a workout day by order field', () => {
    const specs = [
      makeSpec({ lift: 'B', offset: 0, order: 2 }),
      makeSpec({ lift: 'A', offset: 0, order: 1 }),
    ];

    const days = buildWorkoutDays(specs, '2026-01-01');

    expect(days[0]?.lifts.map((l) => l.lift)).toEqual(['A', 'B']);
  });

  it('handles end-of-month date arithmetic correctly', () => {
    const specs = [makeSpec({ offset: 3 })];
    const days = buildWorkoutDays(specs, '2026-01-30');
    expect(days[0]?.date).toBe('2026-02-02');
  });
});

describe('buildWorkoutDays — multi-week grouping and canonical-length expansion (issue #740)', () => {
  it('does not collide workouts that share an offset across different weeks', () => {
    // 5-3-1-shaped base spec: offsets {0,3} repeated across weeks 1..3. Grouping by
    // offset alone would collapse the three weeks' offset-0 (and offset-3) workouts
    // into two mega-cards of 6 lifts. No `program` → canonical length falls back to
    // the base-spec block size (3 weeks), isolating the grouping behavior.
    const specs = [1, 2, 3].flatMap((week) => [
      makeSpec({ week, offset: 0, lift: 'Squat', order: 1 }),
      makeSpec({ week, offset: 0, lift: 'Bench Press', order: 2 }),
      makeSpec({ week, offset: 3, lift: 'Deadlift', order: 1 }),
      makeSpec({ week, offset: 3, lift: 'Overhead Press', order: 2 }),
    ]);

    const days = buildWorkoutDays(specs, '2026-01-05');

    expect(days).toHaveLength(6); // 3 weeks × 2 offsets — NOT 2 collided cards
    expect(days.every((d) => d.lifts.length === 2)).toBe(true); // 2 lifts each, not 6
    expect(days.map((d) => d.week)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(days.map((d) => d.workoutNum)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(days[0]?.lifts.map((l) => l.lift)).toEqual(['Squat', 'Bench Press']);
    // Dates advance a full week per program week: week-2 offset-0 is 7 days after week-1 offset-0.
    expect(days[0]?.date).toBe('2026-01-05');
    expect(days[2]?.date).toBe('2026-01-12');
  });

  it('expands a single-week repeating program to its canonical length', () => {
    // Leangains: a 1-week block of 3 offsets tiled across 12 canonical weeks.
    const base = [0, 2, 4].map((offset, i) =>
      makeSpec({ week: 1, offset, lift: `Lift${i}` }),
    );

    const days = buildWorkoutDays(base, '2026-01-05', 'leangains');

    expect(days).toHaveLength(36); // 12 weeks × 3 workouts
    expect(new Set(days.map((d) => d.week)).size).toBe(12);
    expect(days.filter((d) => d.week === 12)).toHaveLength(3);
    // workoutNum is a global sequential index over (week, offset).
    expect(days[3]?.workoutNum).toBe(4);
    expect(days[3]?.week).toBe(2);
  });

  it('no-schedule card date is macrocycleStart + (week-1)*7 + offset — matches the workout-detail date (issue #745)', () => {
    // Same leangains 2-offset block + macrocycleStart the API mappers/controller specs use
    // for the detail page, so this locks card date == detail date. workout 3 →
    // (week 2, offset 0) → 2026-04-20 + 7 = 2026-04-27 (the API asserts the same).
    const base = [0, 2].map((offset, i) => makeSpec({ week: 1, offset, lift: `Lift${i}` }));

    const days = buildWorkoutDays(base, '2026-04-20', 'leangains');

    expect(days[2]?.workoutNum).toBe(3);
    expect(days[2]?.week).toBe(2);
    expect(days[2]?.date).toBe('2026-04-27');
  });

  it('does not collide a 3-week custom program whose lifts all share offset 0', () => {
    // Every ProgramEditor custom program is a 3-week spec with all lifts at offset 0.
    const specs = [1, 2, 3].flatMap((week) =>
      ['Squat', 'Bench Press'].map((lift, i) =>
        makeSpec({ week, offset: 0, lift, order: i + 1 }),
      ),
    );

    const days = buildWorkoutDays(specs, '2026-01-05');

    expect(days).toHaveLength(3); // one workout per week — NOT one collided card of 6 lifts
    expect(days.map((d) => d.week)).toEqual([1, 2, 3]);
    expect(days.every((d) => d.lifts.length === 2)).toBe(true);
  });
});

describe('workoutDateResolver — the dashboard’s one date precedence (issue #1023)', () => {
  const day = (workoutNum: number, date: string) => ({ workoutNum, date });
  const scheduledWeek = {
    week: 1,
    workouts: [
      { workoutNum: 1, date: '2026-05-18', skipped: false },
      { workoutNum: 2, date: '2026-05-20', skipped: false },
    ],
    completed: false,
  };

  it('prefers an override, then the scheduled date, then the spec-relative date', () => {
    const dateOf = workoutDateResolver({ weeks: [scheduledWeek], dateOverrides: { 2: '2026-05-23' } });
    expect(dateOf(day(1, '2026-05-19'))).toBe('2026-05-18'); // scheduled beats spec-relative
    expect(dateOf(day(2, '2026-05-21'))).toBe('2026-05-23'); // override beats scheduled
    expect(dateOf(day(3, '2026-05-25'))).toBe('2026-05-25'); // neither: spec-relative
  });

  it('uses the spec-relative date for every workout with no schedule and no overrides', () => {
    const dateOf = workoutDateResolver({ weeks: [], dateOverrides: {} });
    expect(dateOf(day(1, '2026-05-19'))).toBe('2026-05-19');
  });
});

describe('computePlannedSets', () => {
  it('computes warmup and work sets from training max', () => {
    const spec = makeSpec({
      warmUpPct: '0.4,0.5,0.6',
      sets: 3,
      reps: 5,
      wtDecrementPct: 0,
      increment: 5,
    });

    const sets = computePlannedSets(spec, 200);

    const warmups = sets.filter((s) => s.setLabel.startsWith('Warm-up'));
    const worksets = sets.filter((s) => s.setLabel.startsWith('Set'));

    expect(warmups).toHaveLength(3);
    expect(warmups[0]).toMatchObject({ weight: 80, reps: 5 }); // 200 * 0.4 = 80
    expect(warmups[1]).toMatchObject({ weight: 100, reps: 4 }); // 200 * 0.5 = 100
    expect(warmups[2]).toMatchObject({ weight: 120, reps: 3 }); // 200 * 0.6 = 120

    expect(worksets).toHaveLength(3);
    expect(worksets[0]).toMatchObject({ weight: 200, reps: 5 }); // 200 * 1.0
  });

  it('rounds weights to the nearest increment using MROUND', () => {
    const spec = makeSpec({ warmUpPct: '0.4', sets: 1, wtDecrementPct: 0, increment: 5 });
    const sets = computePlannedSets(spec, 205);
    // 205 * 0.4 = 82 → MROUND(82, 5) = 80
    expect(sets[0]?.weight).toBe(80);
    // 205 * 1.0 = 205 → MROUND(205, 5) = 205
    expect(sets[1]?.weight).toBe(205);
  });

  it('applies weight decrement across work sets', () => {
    const spec = makeSpec({
      warmUpPct: '',
      sets: 3,
      reps: 8,
      wtDecrementPct: 0.05,
      increment: 2.5,
    });

    const sets = computePlannedSets(spec, 100);
    const worksets = sets.filter((s) => s.setLabel.startsWith('Set'));

    expect(worksets[0]?.weight).toBe(100); // 100 * 1.0
    expect(worksets[1]?.weight).toBe(95); // 100 * 0.95 = 95 → MROUND(95, 2.5) = 95
    expect(worksets[2]?.weight).toBe(90); // 100 * 0.90 = 90 → MROUND(90, 2.5) = 90
  });

  it('omits warmup sets when warmUpPct is empty', () => {
    const spec = makeSpec({ warmUpPct: '', sets: 2, wtDecrementPct: 0 });
    const sets = computePlannedSets(spec, 100);
    expect(sets.every((s) => s.setLabel.startsWith('Set'))).toBe(true);
  });

  it('clamps warmup reps to 1 for programs with more than 5 warmup sets', () => {
    const spec = makeSpec({ warmUpPct: '0.4,0.45,0.5,0.55,0.6,0.65', sets: 1, wtDecrementPct: 0 });
    const sets = computePlannedSets(spec, 200);
    const warmups = sets.filter((s) => s.setLabel.startsWith('Warm-up'));
    expect(warmups).toHaveLength(6);
    expect(warmups[5]?.reps).toBe(1);
  });
});

describe('planLift — the one plan the logger, the detail page and the timer share (#1153)', () => {
  const spec = makeSpec({ warmUpPct: '0.5', sets: 1, wtDecrementPct: 0, increment: 5 });

  it("plans from the lift's max", () => {
    expect(planLift(spec, 200).map((s) => s.weight)).toEqual([100, 200]);
  });

  it("plans from an own modification's max when there is one", () => {
    expect(planLift(spec, 200, 150).map((s) => s.weight)).toEqual([75, 150]);
  });

  it('plans nothing for a lift with no spec row', () => {
    expect(planLift(undefined, 200, 150)).toEqual([]);
  });
});

// The proposal's Cable Curl example (docs/proposals/2026-11-10-lift-progression-types.md): range
// 8–12 at 30; 12,11,10 then 12,12,12 moves the max to 32.5, and the next plan is 3×8 at 32.5.
describe('planLift — the plan follows the lift’s progression type (#1211)', () => {
  const work = (sets: ReturnType<typeof planLift>) =>
    sets.filter((s) => s.type === 'work').map((s) => `${s.reps}@${s.weight}`);
  const curlRow = makeSpec({ lift: 'Cable Curl', sets: 3, reps: 12, repsLow: 8, progression: 'double', increment: 2.5, warmUpPct: '0.5' });
  const double = { type: 'double' as const, repsLow: 8, repsHigh: 12, increment: 2.5 };

  it('plans the Cable Curl double at the bottom of its range right after the bump', () => {
    const plan = planLift(curlRow, 32.5, undefined, {
      progression: double,
      maxDate: '2026-01-07T00:00:00.000Z',
      lastSession: { date: '2026-01-07', reps: [12, 12, 12] },
    });
    expect(work(plan)).toEqual(['8@32.5', '8@32.5', '8@32.5']);
    // The row's warm-ups still lead it.
    expect(plan.filter((s) => s.type === 'warmup')).toHaveLength(1);
  });

  it("plans last session's reps before the bump", () => {
    const plan = planLift(curlRow, 30, undefined, {
      progression: double,
      maxDate: '2026-01-01T00:00:00.000Z',
      lastSession: { date: '2026-01-05', reps: [12, 11, 10] },
    });
    expect(work(plan)).toEqual(['12@30', '11@30', '10@30']);
  });

  it('plans the bottom of the range with no last session, and from an own max when one is on', () => {
    expect(work(planLift(curlRow, 30, 25, { progression: double }))).toEqual(['8@25', '8@25', '8@25']);
  });

  it('plans an off-program linear lift at its repsHigh, as many sets as last time', () => {
    const linear = { type: 'linear' as const, repsLow: null, repsHigh: 10, increment: 1.25 };
    expect(work(planLift(undefined, 41.25, undefined, { progression: linear }))).toEqual(['10@41.25', '10@41.25', '10@41.25']);
    const lastSession = { date: '2026-01-05', reps: [10, 9] };
    expect(work(planLift(undefined, 41.25, undefined, { progression: linear, lastSession }))).toEqual(['10@41.25', '10@41.25']);
  });

  it('plans nothing off-program for a lift with no target, no max, or a type with no rep rule', () => {
    const linear = { type: 'linear' as const, repsLow: null, repsHigh: null, increment: 1.25 };
    expect(planLift(undefined, 40, undefined, { progression: linear })).toEqual([]);
    expect(planLift(undefined, 0, undefined, { progression: { ...linear, repsHigh: 10 } })).toEqual([]);
    expect(planLift(undefined, 40, undefined, { progression: { ...linear, type: 'manual', repsHigh: 10 } })).toEqual([]);
  });

  it('plans an in-program lift on any other type by its row, as before', () => {
    const squat = makeSpec({ sets: 2, reps: 5, wtDecrementPct: 0.1, warmUpPct: '' });
    const linear = { type: 'linear' as const, repsLow: null, repsHigh: 5, increment: 5 };
    expect(planLift(squat, 200, undefined, { progression: linear })).toEqual(planLift(squat, 200));
  });
});

describe('buildLiftDetails — each lift’s prescription resolves through its day (issue #1014)', () => {
  // The spec endpoint serves the one stored block, while a workout carries its
  // *program* week and its day's offset. Pre-#1014 the lookup matched
  // `s.week === workout.week` and the lift's own name, so week-2+ workouts planned
  // nothing, a lift trained twice a week always took its first day's
  // prescription, and a Manage Lifts replacement found no row at all.
  const workout = (
    week: number,
    offset: number | null | undefined,
    lifts: { lift: string; replaces?: string }[],
  ) => ({
    week,
    ...(offset !== undefined && { offset }),
    lifts: lifts.map((l) => ({ ...l, sets: [], planned: true })),
  });
  const workSets = (detail: WorkoutLiftDetail | undefined) =>
    detail?.plannedSets.filter((s) => s.type === 'work').map((s) => [s.weight, s.reps]);
  const max = (lift: string, weight: number) => ({ lift, weight, dateUpdated: '2025-12-29' });

  it('plans a week-2 workout of a 1-week repeating block from its block week', () => {
    const specs = [
      makeSpec({ lift: 'Bench Press', offset: 0, reps: 6 }),
      makeSpec({ lift: 'Squat', offset: 2 }),
    ];
    const [bench] = buildLiftDetails(workout(2, 0, [{ lift: 'Bench Press' }]), specs, [
      max('Bench Press', 200),
    ]);
    expect(bench).toMatchObject({ lift: 'Bench Press', tm: 200, warmUpCount: 3, workCount: 3 });
    expect(workSets(bench)).toEqual([[200, 6], [200, 6], [200, 6]]);
  });

  it('plans from a max stored by catalog id, as import stores it (#1118)', () => {
    const [bench] = buildLiftDetails(workout(1, 0, [{ lift: 'Bench Press' }]), [makeSpec({ lift: 'Bench Press' })], [
      max('bench-press', 200),
    ]);
    expect(bench?.tm).toBe(200);
  });

  it('plans a second-wave week from the matching week of a 3-week block', () => {
    // 5-3-1-shaped: each block week carries its own reps (5 / 3 / 1).
    const specs = [
      makeSpec({ week: 1, reps: 5 }),
      makeSpec({ week: 2, reps: 3 }),
      makeSpec({ week: 3, reps: 1 }),
    ];
    const [squat] = buildLiftDetails(workout(5, 0, [{ lift: 'Squat' }]), specs, [
      max('Squat', 300),
    ]);
    // Program week 5 is the second wave's week 2 — the 3-rep week.
    expect(workSets(squat)).toEqual([[300, 3], [300, 3], [300, 3]]);
  });

  it('takes the prescription from the workout’s own day when a lift trains twice a week', () => {
    // Heavy squats on Monday, light on Friday: one lift on two days of the same
    // block week. Matching on the week alone always found Monday's row.
    const specs = [makeSpec({ offset: 0, reps: 5 }), makeSpec({ offset: 4, reps: 10 })];
    const [squat] = buildLiftDetails(workout(1, 4, [{ lift: 'Squat' }]), specs, [
      max('Squat', 200),
    ]);
    expect(workSets(squat)).toEqual([[200, 10], [200, 10], [200, 10]]);
  });

  it('gives each occurrence of a lift the day plans twice its own prescription, matching the dashboard card (issue #1027)', () => {
    // Heavy squats first, then light squats for volume, on one day. Resolving by
    // name gave both occurrences the first row.
    const specs = [
      makeSpec({ lift: 'Squat', order: 1, reps: 5 }),
      makeSpec({ lift: 'Bench Press', order: 2, reps: 8 }),
      makeSpec({ lift: 'Squat', order: 3, reps: 12 }),
    ];
    const details = buildLiftDetails(
      workout(1, 0, [{ lift: 'Squat' }, { lift: 'Bench Press' }, { lift: 'Squat' }]),
      specs,
      [
        max('Squat', 200),
        max('Bench Press', 150),
      ],
    );
    expect(details.map((d) => [d.lift, workSets(d)?.[0]])).toEqual([
      ['Squat', [200, 5]],
      ['Bench Press', [150, 8]],
      ['Squat', [200, 12]],
    ]);
    // The card the workout opens from lists the same day's rows.
    const [card] = buildWorkoutDays(specs, '2026-01-05');
    expect(card?.lifts.map((row) => [row.lift, row.reps])).toEqual([
      ['Squat', 5],
      ['Bench Press', 8],
      ['Squat', 12],
    ]);
  });

  it('plans nothing for a lift the program trains on a different day', () => {
    // A lift logged ad hoc on Monday that the program schedules for Wednesday
    // has no prescription on this day. It keeps an empty entry rather than
    // being dropped: position is a lift's identity for the timer.
    const specs = [makeSpec({ lift: 'Bench Press', offset: 0 }), makeSpec({ lift: 'Squat', offset: 2 })];
    const details = buildLiftDetails(
      workout(1, 0, [{ lift: 'Bench Press' }, { lift: 'Squat' }]),
      specs,
      [],
    );
    expect(details.map((d) => [d.lift, d.plannedSets.length])).toEqual([
      ['Bench Press', 6],
      ['Squat', 0],
    ]);
  });

  it('gives a Manage Lifts replacement the replaced slot’s prescription, priced from its own training max', () => {
    // A swap changes the movement, not the slot: sets, reps, percentages,
    // increment and activation come from the slot; only the weights change.
    const squatSlot = makeSpec({ sets: 3, reps: 5, wtDecrementPct: 0.1, activation: 'Hip Airplane' });
    const [front] = buildLiftDetails(
      workout(1, 0, [{ lift: 'Front Squat', replaces: 'Squat' }]),
      [squatSlot],
      [
        max('Squat', 300),
        max('Front Squat', 200),
      ],
    );
    expect(front).toMatchObject({
      lift: 'Front Squat',
      tm: 200,
      activationMovement: 'Hip Airplane',
      warmUpCount: 3,
      workCount: 3,
    });
    expect(workSets(front)).toEqual([[200, 5], [180, 5], [160, 5]]);
  });

  it('gives a lift swapped into an added lift’s slot no prescription (#1026)', () => {
    // An added lift fills no program slot on this day, so its replacement has none
    // to inherit — even when the program trains the added lift on another day.
    const specs = [makeSpec({ lift: 'Squat', offset: 0 }), makeSpec({ lift: 'Chin-up', offset: 2 })];
    const details = buildLiftDetails(
      workout(1, 0, [{ lift: 'Squat' }, { lift: 'Pull-up', replaces: 'Chin-up' }]),
      specs,
      [],
    );
    expect(details.map((d) => [d.lift, d.plannedSets.length])).toEqual([
      ['Squat', 6],
      ['Pull-up', 0],
    ]);
  });

  it('matches on the block week alone for a response without an offset', () => {
    // An API that predates `offset` (one rolled back under a newer web) says
    // only the week; its block week is still the right place to look.
    const [squat] = buildLiftDetails(
      workout(3, undefined, [{ lift: 'Squat' }]),
      [makeSpec({ lift: 'Squat', offset: 2 })],
      [max('Squat', 200)],
    );
    expect(squat?.workCount).toBe(3);
  });

  it('plans nothing on a workout the program has no day for', () => {
    // `offset: null` is a scheduled workout past the program's last day (#1023).
    // A lift added or logged there has no prescription, even one the block trains
    // on another day. Only a response with no offset at all falls back to the
    // block week.
    const [squat] = buildLiftDetails(
      workout(3, null, [{ lift: 'Squat' }]),
      [makeSpec({ lift: 'Squat', offset: 2 })],
      [max('Squat', 200)],
    );
    expect(squat).toMatchObject({ lift: 'Squat', tm: 200, warmUpCount: 0, workCount: 0 });
  });
});

const makeCell = (
  status: WorkoutCell['status'],
  workoutNum = 1,
): WorkoutCell => ({
  workoutNum,
  date: '2026-01-05',
  status,
  lifts: [],
});

const makeWeek = (
  week: number,
  statuses: WorkoutCell['status'][],
): WeekRow => ({
  week,
  workouts: statuses.map((status, i) => makeCell(status, i + 1)),
});

describe('computeMacrocycleProgress', () => {
  it('returns zeroes for an empty macrocycle', () => {
    expect(computeMacrocycleProgress([])).toEqual({
      completedWorkouts: 0,
      totalWorkouts: 0,
      percent: 0,
    });
  });

  it('reports 100% when every workout is completed', () => {
    const weeks: WeekRow[] = [makeWeek(1, ['completed', 'completed'])];
    expect(computeMacrocycleProgress(weeks)).toEqual({
      completedWorkouts: 2,
      totalWorkouts: 2,
      percent: 100,
    });
  });

  it('counts only completed toward the numerator; skipped/missed count toward the denominator only', () => {
    const weeks: WeekRow[] = [
      makeWeek(1, ['completed', 'skipped', 'missed', 'upcoming']),
    ];
    const progress = computeMacrocycleProgress(weeks);
    expect(progress.completedWorkouts).toBe(1);
    expect(progress.totalWorkouts).toBe(4);
    expect(progress.percent).toBe(25);
  });

  it('sums totals across multiple week rows', () => {
    const weeks: WeekRow[] = [
      makeWeek(1, ['completed', 'completed', 'completed']),
      makeWeek(2, ['completed', 'upcoming', 'upcoming']),
    ];
    const progress = computeMacrocycleProgress(weeks);
    expect(progress.completedWorkouts).toBe(4);
    expect(progress.totalWorkouts).toBe(6);
    expect(progress.percent).toBe(67); // 4 / 6 = 66.67 → 67
  });

  it('rounds percent to the nearest integer', () => {
    // 1 of 3 completed = 33.33% → 33
    const weeks: WeekRow[] = [makeWeek(1, ['completed', 'upcoming', 'upcoming'])];
    expect(computeMacrocycleProgress(weeks).percent).toBe(33);
  });
});
