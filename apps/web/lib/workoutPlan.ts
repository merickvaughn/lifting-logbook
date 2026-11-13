import {
  MROUND,
  PROG_SPEC_WARMUP_PCTS,
  PROG_SPEC_WORK_PCTS,
  WARMUP_BASE_REPS,
  activationExercise,
  baseSpecMesocycleWeeks,
  currentMaxLookup,
  mesocycleWeekForProgramWeek,
  noScheduleWorkoutDateUTC,
  plannedLiftRows,
  programWorkoutKeys,
  specRowsForWorkoutDay,
} from '@lifting-logbook/core';
import type { ResolvedProgression } from '@lifting-logbook/core';
import type {
  MacrocycleDashboardResponse,
  LiftingProgramSpecResponse,
  TrainingMaxResponse,
  WorkoutResponse,
} from '@lifting-logbook/types';

export interface PlannedSet {
  type: 'warmup' | 'work';
  setLabel: string;
  weight: number;
  reps: number;
}

export interface WorkoutDay {
  workoutNum: number;
  week: number;
  date: string; // YYYY-MM-DD
  lifts: LiftingProgramSpecResponse[];
}

export interface WorkoutCell {
  workoutNum: number;
  date: string; // YYYY-MM-DD
  status: 'completed' | 'upcoming' | 'missed' | 'skipped';
  lifts: { name: string; sets: PlannedSet[] }[];
}

export interface WeekRow {
  week: number;
  workouts: WorkoutCell[];
}

/**
 * Tiles a program's stored block to its canonical length and returns the ordered
 * list of workout days, one per distinct `(week, offset)`, with derived dates.
 *
 * Grouping is by `(week, offset)` — not `offset` alone, which collides workouts
 * that share an offset across weeks (5-3-1's 6 workouts, or a 3-week custom
 * program with every lift at offset 0) into a single card. The stored spec is
 * only one repeating block, so it is first expanded to `programLengthWeeks`
 * (leangains 12 wks, rpt 8, etc.); `program` is optional and falls back to the
 * base-spec block length for custom / unregistered programs.
 *
 * `workoutNum` indexes {@link programWorkoutKeys} — the numbering the workout
 * endpoint resolves a workout's day with and schedule generation dates — so a
 * card's `workoutNum` always resolves to the workout it links to (issue #740),
 * with or without a schedule (#1023).
 */
export function buildWorkoutDays(
  specs: LiftingProgramSpecResponse[],
  macrocycleStartDate: string,
  program?: string,
): WorkoutDay[] {
  const [y, m, d] = macrocycleStartDate.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const startDate = new Date(Date.UTC(y, m - 1, d));

  return programWorkoutKeys(program ?? '', specs).map((k, i) => ({
    workoutNum: i + 1,
    week: k.week,
    // macrocycleStart + (week-1)*7 + offset, via the shared core helper the API's
    // no-schedule detail fallback (toWorkoutResponse) also calls — so a card's
    // date can never drift from the workout it opens (issues #740, #745).
    date: noScheduleWorkoutDateUTC(startDate, k.week, k.offset)
      .toISOString()
      .slice(0, 10),
    // The day's rows through the same helper the workout endpoint plans a day
    // with, so a card and the workout it opens start from the same rows (#1014).
    // Stored rows carry their block week; the card's carry the program week.
    lifts: specRowsForWorkoutDay(specs, k.week, k.offset).map((row) => ({ ...row, week: k.week })),
  }));
}

/**
 * How the Macrocycle Dashboard dates a workout: its override if it was rescheduled,
 * else the date the dashboard response lists it on, else its spec-relative date
 * (`WorkoutDay.date`). The grid and the Macrocycle Plan's estimate both date workouts
 * through this, so the two can't drift (issue #1023).
 *
 * With a schedule, the response already applies this order: it lists every workout
 * on its override, else its scheduled date, else its spec-relative date. The fallbacks
 * here matter without a schedule, where `weeks` is empty, and against an older API pod
 * during a non-atomic web/api rolling deploy. That is also why `dateOverrides` is read
 * with `?.`: a response missing it degrades instead of crashing the page.
 */
export function workoutDateResolver(
  dashboard: Pick<MacrocycleDashboardResponse, 'weeks' | 'dateOverrides'>,
): (day: Pick<WorkoutDay, 'workoutNum' | 'date'>) => string {
  const listed = new Map<number, string>();
  for (const week of dashboard.weeks) {
    for (const ws of week.workouts) listed.set(ws.workoutNum, ws.date);
  }
  return (day) =>
    dashboard.dateOverrides?.[day.workoutNum] ?? listed.get(day.workoutNum) ?? day.date;
}

/**
 * Computes planned warmup and work sets for a lift given a training max.
 *
 * Uses PROG_SPEC_WARMUP_PCTS / PROG_SPEC_WORK_PCTS / MROUND from
 * @lifting-logbook/core — the same math as the spreadsheet layer, without
 * the SpreadsheetCell[][] wrapper.
 */
export function computePlannedSets(
  spec: LiftingProgramSpecResponse,
  trainingMax: number,
): PlannedSet[] {
  const warmupPcts = PROG_SPEC_WARMUP_PCTS(spec.warmUpPct).filter(
    (p) => !isNaN(p) && p > 0,
  );
  const workPcts = PROG_SPEC_WORK_PCTS(spec.sets, spec.wtDecrementPct) as number[];

  const warmupSets: PlannedSet[] = warmupPcts.map((pct, i) => ({
    type: 'warmup',
    setLabel: `Warm-up ${i + 1}`,
    weight: MROUND(trainingMax * pct, spec.increment),
    reps: Math.max(1, WARMUP_BASE_REPS - i),
  }));

  const workSets: PlannedSet[] = workPcts.map((pct, i) => ({
    type: 'work',
    setLabel: `Set ${i + 1}`,
    weight: MROUND(trainingMax * pct, spec.increment),
    reps: spec.reps,
  }));

  return [...warmupSets, ...workSets];
}

/**
 * What the logger plans a lift by besides its spec row (#1211): its resolved progression, when
 * its max last moved, and its last session. Without it a lift plans by its row, as before.
 */
export interface ProgressionPlan {
  /** The lift's resolved type, rep range and increment (`resolveProgression`). */
  rule: Pick<ResolvedProgression, 'type' | 'repsLow' | 'repsHigh' | 'increment'>;
  /** When the lift's max last moved: `TrainingMaxResponse.dateUpdated`. */
  maxDate?: string;
  /** A `double` lift's latest session before this workout: its date and each set's reps, by set number. */
  lastSession?: { date: string; reps: number[] };
}

/** How many sets a lift with no spec row plans, unless a `double` lift copies its last session's count. */
const OFF_PROGRAM_SETS = 3;

/** `count` working sets at one weight, numbered from 1, after `warmUps`. */
function flatSets(warmUps: PlannedSet[], count: number, weight: number, repsFor: (i: number) => number): PlannedSet[] {
  const work = Array.from({ length: count }, (_, i): PlannedSet => ({
    type: 'work',
    setLabel: `Set ${i + 1}`,
    weight,
    reps: repsFor(i),
  }));
  return [...warmUps, ...work];
}

/**
 * A `double` lift's plan (#1211): every set at the max, which is the working weight. Right after a
 * bump (the max moved on or after the last session, or there is no last session) it plans the
 * bottom of the range; otherwise each set repeats last session's reps, to beat them. From an own
 * max it plans the bottom: the lift's last session and max date don't say when that max moved.
 */
function planDouble(
  spec: LiftingProgramSpecResponse | undefined,
  max: number,
  plan: ProgressionPlan,
  fromOwnMax: boolean,
): PlannedSet[] {
  const { repsLow, repsHigh, increment } = plan.rule;
  // In a program the row's reps are the top; off it, the lift's `repsHigh`.
  const bottom = repsLow ?? spec?.reps ?? repsHigh;
  if (bottom === null || (!spec && max <= 0)) return [];
  const last = plan.lastSession;
  const day = (date: string) => date.slice(0, 10);
  const bumped = plan.maxDate !== undefined && last !== undefined && day(plan.maxDate) >= day(last.date);
  const lastReps = last && !bumped && !fromOwnMax ? last.reps : [];
  const warmUps = spec ? computePlannedSets(spec, max).filter((s) => s.type === 'warmup') : [];
  const count = spec?.sets ?? (last?.reps.length || OFF_PROGRAM_SETS);
  // The resolved increment is the row's inside a program.
  return flatSets(warmUps, count, MROUND(max, increment), (i) => lastReps[i] ?? bottom);
}

/**
 * The sets one lift occurrence plans (#1153): its spec row's, from an `own` modification's max
 * when one is given, otherwise from the lift's. The logger, the detail page and the timer share
 * this formula; only the logger passes an own max, when a toggle with one is on, since a slot has
 * no start-on modifications yet.
 *
 * Only the logger passes a `progression` (#1211), which plans by the lift's type: a `double` lift
 * plans its range ({@link planDouble}), and a lift with no spec row on `linear` or `amrap_gated`
 * plans {@link OFF_PROGRAM_SETS} sets of its `repsHigh` at its max. Every other lift with a row
 * plans the row. With no spec row and nothing else to go by (an added lift, or a focus lift) it
 * plans nothing.
 */
export function planLift(
  spec: LiftingProgramSpecResponse | undefined,
  liftMax: number,
  { ownMax, progression }: { ownMax?: number; progression?: ProgressionPlan } = {},
): PlannedSet[] {
  const max = ownMax ?? liftMax;
  const rule = progression?.rule;
  if (progression && rule?.type === 'double') return planDouble(spec, max, progression, ownMax !== undefined);
  if (spec) return computePlannedSets(spec, max);
  const repsHigh = rule?.repsHigh;
  if (rule && (rule.type === 'linear' || rule.type === 'amrap_gated') && repsHigh != null && max > 0) {
    return flatSets([], OFF_PROGRAM_SETS, MROUND(max, rule.increment), () => repsHigh);
  }
  return [];
}

/**
 * A plan as the logger lays it out: the warm-ups, then the working sets numbered from 1. The page
 * builds a lift's sets with it and the logger re-plans with it, so a re-planned set lines up with
 * the slot it replaces (#1153).
 */
export function liftSets(planned: readonly PlannedSet[]): {
  warmUpSets: { reps: number; totalLoad: number }[];
  workSets: { setNum: number; reps: number; totalLoad: number }[];
} {
  return {
    warmUpSets: planned.filter((s) => s.type === 'warmup').map((s) => ({ reps: s.reps, totalLoad: s.weight })),
    workSets: planned
      .filter((s) => s.type === 'work')
      .map((s, i) => ({ setNum: i + 1, reps: s.reps, totalLoad: s.weight })),
  };
}

export interface MacrocycleProgress {
  completedWorkouts: number;
  totalWorkouts: number;
  /** 0–100, rounded to the nearest integer. 0 when totalWorkouts is 0. */
  percent: number;
}

/**
 * Workout-completion progress for the current macrocycle, derived from the WeekRow[]
 * the dashboard already assembles (see MacrocycleDashboardGrid). Only
 * status === 'completed' counts toward the numerator; skipped and missed
 * workouts still count toward the denominator (they're part of the macrocycle) but
 * weren't performed, so they don't count as done.
 */
export function computeMacrocycleProgress(weeks: WeekRow[]): MacrocycleProgress {
  let completedWorkouts = 0;
  let totalWorkouts = 0;
  for (const row of weeks) {
    for (const cell of row.workouts) {
      totalWorkouts++;
      if (cell.status === 'completed') completedWorkouts++;
    }
  }
  const percent =
    totalWorkouts > 0 ? Math.round((completedWorkouts / totalWorkouts) * 100) : 0;
  return { completedWorkouts, totalWorkouts, percent };
}

/**
 * One lift of a workout as the detail page renders it and the timer plans it.
 *
 * Built by {@link buildLiftDetails}, index-aligned with `workout.lifts`; the
 * timer reads it through `toTimerLiftPlans`, so this is the one shape both
 * routes share (issue #984).
 */
export interface WorkoutLiftDetail {
  lift: string;
  /** Training max in lbs — the storage unit; display conversion happens later. */
  tm: number;
  /**
   * The lift's activation movement, or `undefined` when the program names none.
   *
   * Narrowed exactly once, here, via `activationExercise`: the spec's raw
   * `activation` column also carries legacy classification markers
   * (`'compound'` / `'n/a'`), which are not movements. Named `activationMovement`
   * rather than `activation` so a consumer still expecting the raw column fails
   * to compile instead of re-narrowing — or forgetting to.
   *
   * Required-but-nullable, not optional: an optional key would let the raw-column
   * shape satisfy this interface structurally (excess-property checking only fires
   * on a fresh literal passed directly as an argument), which is exactly the
   * substitution the rename exists to prevent. Every construction site — fixtures
   * included — therefore has to spell the decision out.
   */
  activationMovement: string | undefined;
  warmUpCount: number;
  workCount: number;
  plannedSets: PlannedSet[];
}

/**
 * The spec row prescribing each of a workout's lifts, index-aligned with
 * `workout.lifts`; `undefined` where the program plans none on that day (a lift
 * logged ad hoc, or one added through Manage Lifts or swapped into an added
 * lift's slot, #1026).
 *
 * `workout.week` is the *program* week while `specs` is the one stored block, so
 * the day resolves through the block week at the workout's `offset` — the same
 * `specRowsForWorkoutDay` the API chose the day's lifts with (issue #1014). A
 * Manage Lifts replacement is looked up by the slot it `replaces`: a swap changes
 * the movement, not the slot, so it inherits that prescription (the caller prices
 * it from the replacement's own training max). Both steps are core's
 * `plannedLiftRows`, the rule progression resolves a planned lift with too.
 *
 * `offset: null` is a workout the program has no day for (#1023): nothing on it
 * has a prescription. A response with no `offset` at all comes from an API that
 * predates the field — an API rolled back under a newer web — and can only be
 * matched on its block week.
 */
export function liftSpecsForWorkout(
  workout: Pick<WorkoutResponse, 'week' | 'offset' | 'lifts'>,
  specs: readonly LiftingProgramSpecResponse[],
): (LiftingProgramSpecResponse | undefined)[] {
  let dayRows: readonly LiftingProgramSpecResponse[];
  if (workout.offset === null) {
    dayRows = [];
  } else if (workout.offset !== undefined) {
    dayRows = specRowsForWorkoutDay(specs, workout.week, workout.offset);
  } else {
    const mesocycleWeek = mesocycleWeekForProgramWeek(workout.week, baseSpecMesocycleWeeks(specs));
    dayRows = specs.filter((s) => s.week === mesocycleWeek);
  }
  return plannedLiftRows(dayRows, workout.lifts);
}

/**
 * Derives the per-lift plan for a workout from the program spec and the
 * training maxes — one entry per `workout.lifts` entry, in order, never
 * filtered: position is a lift occurrence's identity for the timer (ADR-035
 * Amendment 4), so a lift with no training max is kept as an empty plan.
 * Each lift's prescription comes from {@link liftSpecsForWorkout}; its weights
 * from its own training max — a replacement's, not its slot's.
 */
export function buildLiftDetails(
  workout: Pick<WorkoutResponse, 'week' | 'offset' | 'lifts'>,
  specs: readonly LiftingProgramSpecResponse[],
  maxes: readonly Pick<TrainingMaxResponse, 'lift' | 'weight' | 'dateUpdated'>[],
): WorkoutLiftDetail[] {
  const maxFor = currentMaxLookup(maxes);
  const liftSpecs = liftSpecsForWorkout(workout, specs);
  return workout.lifts.map((wl, i) => {
    const tm = maxFor(wl.lift)?.weight ?? 0;
    const spec = liftSpecs[i];
    // A slot has no start-on modifications yet, so the timer and this page plan from the lift's
    // max, as the logger does before a toggle.
    const plannedSets = planLift(spec, tm);
    return {
      lift: wl.lift,
      tm,
      activationMovement: activationExercise(spec?.activation),
      warmUpCount: plannedSets.filter((s) => s.type === 'warmup').length,
      workCount: plannedSets.filter((s) => s.type === 'work').length,
      plannedSets,
    };
  });
}
