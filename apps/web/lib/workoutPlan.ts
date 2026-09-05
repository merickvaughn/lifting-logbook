import {
  MROUND,
  PROG_SPEC_WARMUP_PCTS,
  PROG_SPEC_WORK_PCTS,
  WARMUP_BASE_REPS,
  activationExercise,
  expandSpecToLength,
  noScheduleWorkoutDateUTC,
  orderedWorkoutKeys,
  programLengthWeeks,
} from '@lifting-logbook/core';
import type {
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
 * `workoutNum` is a global sequential index over {@link orderedWorkoutKeys} — the
 * same helper the API's no-schedule `weekForWorkoutNum` uses — so a card's
 * `workoutNum` always resolves to the workout it links to (issue #740).
 */
export function buildWorkoutDays(
  specs: LiftingProgramSpecResponse[],
  cycleStartDate: string,
  program?: string,
): WorkoutDay[] {
  const [y, m, d] = cycleStartDate.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const startDate = new Date(Date.UTC(y, m - 1, d));

  const fullSpec = expandSpecToLength(specs, programLengthWeeks(program ?? '', specs));

  const byKey = new Map<string, LiftingProgramSpecResponse[]>();
  for (const spec of fullSpec) {
    const key = `${spec.week}:${spec.offset}`;
    const lifts = byKey.get(key) ?? [];
    lifts.push(spec);
    byKey.set(key, lifts);
  }

  return orderedWorkoutKeys(fullSpec).map((k, i) => {
    const lifts = (byKey.get(`${k.week}:${k.offset}`) ?? []).sort(
      (a, b) => a.order - b.order,
    );
    return {
      workoutNum: i + 1,
      week: k.week,
      // cycleStart + (week-1)*7 + offset, via the shared core helper the API's
      // no-schedule detail fallback (toWorkoutResponse) also calls — so a card's
      // date can never drift from the workout it opens (issues #740, #745).
      date: noScheduleWorkoutDateUTC(startDate, k.week, k.offset)
        .toISOString()
        .slice(0, 10),
      lifts,
    };
  });
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

export interface CycleProgress {
  completedWorkouts: number;
  totalWorkouts: number;
  /** 0–100, rounded to the nearest integer. 0 when totalWorkouts is 0. */
  percent: number;
}

/**
 * Workout-completion progress for the current cycle, derived from the WeekRow[]
 * the dashboard already assembles (see CycleDashboardGrid). Only
 * status === 'completed' counts toward the numerator; skipped and missed
 * workouts still count toward the denominator (they're part of the cycle) but
 * weren't performed, so they don't count as done.
 */
export function computeCycleProgress(weeks: WeekRow[]): CycleProgress {
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
 * Derives the per-lift plan for a workout from the program spec and the
 * training maxes — one entry per `workout.lifts` entry, in order, never
 * filtered: position is a lift occurrence's identity for the timer (ADR-035
 * Amendment 4), so a lift with no training max is kept as an empty plan.
 */
export function buildLiftDetails(
  workout: Pick<WorkoutResponse, 'week' | 'lifts'>,
  specs: readonly LiftingProgramSpecResponse[],
  maxes: readonly Pick<TrainingMaxResponse, 'lift' | 'weight'>[],
): WorkoutLiftDetail[] {
  const maxMap = new Map(maxes.map((m) => [m.lift, m.weight]));
  return workout.lifts.map((wl) => {
    const tm = maxMap.get(wl.lift) ?? 0;
    const spec = specs.find((s) => s.week === workout.week && s.lift === wl.lift);
    const plannedSets = spec ? computePlannedSets(spec, tm) : [];
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
