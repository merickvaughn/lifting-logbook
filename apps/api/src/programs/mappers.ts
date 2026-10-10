import {
  MacrocycleDashboard,
  LiftRecord,
  LiftingProgramSpec,
  PlannedLift,
  StrengthGoalEntry,
  TrainingMax,
  TrainingMaxHistoryEntry,
  buildLiftRecordId,
  normalizeAmrap,
  noScheduleWorkoutDateUTC,
  programLengthWeeks,
  programWorkoutKeys,
} from '@lifting-logbook/core';
import {
  MacrocycleDashboardResponse,
  MacrocyclePlanResponse,
  MacrocycleWeekSummary,
  LiftOverrideResponse,
  LiftRecordResponse,
  LiftingProgramSpecResponse,
  SetResponse,
  StrengthGoalResponse,
  TrainingMaxHistoryEntryResponse,
  TrainingMaxResponse,
  WeekNumber,
  WeekType,
  WorkoutLiftResponse,
  WorkoutResponse,
  WorkoutSummary,
} from '@lifting-logbook/types';
import { MacrocyclePlanResult } from '../ports/IMacrocyclePlanningAgent';
import { ScheduledWorkout } from '../ports/IMacrocycleScheduledWorkoutRepository';
import { LiftOverride } from '../ports/IWorkoutLiftOverrideRepository';

// All API date fields are emitted as `YYYY-MM-DD` in UTC. Domain `Date`
// values must be stored as UTC midnight; adapters parsing external sources
// (e.g. Sheets) are responsible for normalizing before the mapper runs.
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const toStrengthGoalResponse = (g: StrengthGoalEntry): StrengthGoalResponse => ({
  lift: g.lift,
  goalType: g.goalType,
  ...(g.target !== undefined && { target: g.target }),
  unit: g.unit,
  ...(g.ratio !== undefined && { ratio: g.ratio }),
  updatedAt: isoDate(g.updatedAt),
});

export const toTrainingMaxResponse = (m: TrainingMax): TrainingMaxResponse => ({
  lift: m.lift,
  weight: m.weight,
  unit: 'lbs',
  dateUpdated: isoDate(m.dateUpdated),
});

export const toTrainingMaxHistoryEntryResponse = (
  e: TrainingMaxHistoryEntry,
): TrainingMaxHistoryEntryResponse => ({
  id: e.id,
  lift: e.lift,
  weight: e.weight,
  unit: 'lbs',
  date: isoDate(e.date),
  isPR: e.isPR,
  source: e.source,
  goalMet: e.goalMet,
});

export const toLiftRecordResponse = (r: LiftRecord): LiftRecordResponse => ({
  id: buildLiftRecordId(r.program, r),
  program: r.program,
  macrocycleNum: r.macrocycleNum,
  workoutNum: r.workoutNum,
  date: isoDate(r.date),
  lift: r.lift,
  setNum: r.setNum,
  weight: r.weight,
  reps: r.reps,
  notes: r.notes,
});

export const toLiftingProgramSpecResponse = (
  s: LiftingProgramSpec,
): LiftingProgramSpecResponse => ({
  week: s.week,
  lift: s.lift,
  order: s.order,
  offset: s.offset,
  increment: s.increment,
  sets: s.sets,
  reps: s.reps,
  amrap: normalizeAmrap(s.amrap),
  warmUpPct: s.warmUpPct,
  wtDecrementPct: s.wtDecrementPct,
  activation: s.activation,
});

/**
 * Maps a MacrocycleDashboard to a MacrocycleDashboardResponse with no schedule data.
 * Used when no scheduled workouts exist (no-schedule mode).
 *
 * `currentWeekType` is passed explicitly because it is derived at request time
 * via `weekTypeForDate(dashboard.macrocycleDate, programSpec)`, not stored on the
 * dashboard model.
 */
export const toMacrocycleDashboardResponse = (
  d: MacrocycleDashboard,
  currentWeekType: WeekType,
  dateOverrides: Record<number, string> = {},
  skippedWorkoutNums: number[] = [],
  completedWorkoutNums: number[] = [],
): MacrocycleDashboardResponse => ({
  program: d.program,
  macrocycleNum: d.macrocycleNum,
  macrocycleStartDate: isoDate(d.macrocycleDate),
  weeks: [],
  currentWeekType,
  dateOverrides,
  skippedWorkoutNums,
  completedWorkoutNums,
});

/**
 * What {@link buildMacrocycleDashboardResponse} builds a response from besides the
 * dashboard row. Named rather than positional, like {@link WorkoutResponseOptions}
 * (#750), so the collections can't be transposed at the call site.
 */
export interface MacrocycleDashboardInputs {
  /**
   * The program's stored spec. The macrocycle's workouts are numbered from it inside the
   * builder (`programWorkoutKeys(d.program, spec)`), so a caller can't hand it some
   * other numbering (#1023).
   */
  spec: ReadonlyArray<{ week: WeekNumber; offset: number }>;
  /** The macrocycle's scheduled rows; empty in no-schedule mode. */
  scheduled: readonly ScheduledWorkout[];
  /** Rescheduled dates, by `workoutNum`. */
  overrides: ReadonlyMap<number, Date>;
  /** `workoutNum`s with at least one logged lift record. */
  completedWorkoutNums: ReadonlySet<number>;
  /** `workoutNum`s explicitly skipped. */
  skippedNums?: ReadonlySet<number> | undefined;
}

/**
 * Builds a MacrocycleDashboardResponse. The per-workout metadata covers the whole macrocycle
 * in both modes; `weeks` is empty with no schedule.
 *
 * With a schedule, `weeks` lists every workout of the program under its program
 * week. Workouts are numbered by `programWorkoutKeys`, as in the Macrocycle Dashboard
 * grid and the workout endpoint, and the week is also the one the plan page's
 * phases count. Each workout is dated by its override, else the date its schedule
 * gave it, else the spec-relative date the grid and the endpoint give a day with no
 * scheduled row; macrocycles scheduled before #1023 with fewer days a week than their
 * program have such days. A scheduled row supplies only a date, never a week:
 * rows saved before #1023 carry the schedule's calendar week, and a row past the
 * program's last day dates no workout, so it is left out. A week is completed when
 * every workout in it has at least one lift record or is explicitly skipped.
 */
export function buildMacrocycleDashboardResponse(
  d: MacrocycleDashboard,
  currentWeekType: WeekType,
  inputs: MacrocycleDashboardInputs,
): MacrocycleDashboardResponse {
  const { spec, scheduled, overrides, completedWorkoutNums, skippedNums = new Set<number>() } = inputs;
  // Per-workout metadata for the whole macrocycle, surfaced top-level so the macrocycle
  // dashboard can render every tiled workout's status without a per-workout fetch
  // (issue #740). Populated identically in both modes; only `weeks` differs.
  const dateOverrides: Record<number, string> = {};
  for (const [workoutNum, date] of overrides) {
    dateOverrides[workoutNum] = isoDate(date);
  }
  const skippedList = [...skippedNums].sort((a, b) => a - b);
  const completedList = [...completedWorkoutNums].sort((a, b) => a - b);

  if (scheduled.length === 0) {
    return toMacrocycleDashboardResponse(
      d,
      currentWeekType,
      dateOverrides,
      skippedList,
      completedList,
    );
  }

  const scheduledDates = new Map(scheduled.map((sw) => [sw.workoutNum, sw.scheduledDate]));
  // Every week of the program is listed, even one it trains no day in (a custom spec
  // can skip one: weeks 1 and 3, say). Empty, it is completed, so a plan-page phase
  // containing it can still complete.
  const weekAcc = new Map<WeekNumber, WorkoutSummary[]>();
  for (let week = 1; week <= programLengthWeeks(d.program, spec); week++) weekAcc.set(week, []);
  programWorkoutKeys(d.program, spec).forEach(({ week, offset }, i) => {
    const workoutNum = i + 1;
    const date =
      overrides.get(workoutNum) ??
      scheduledDates.get(workoutNum) ??
      noScheduleWorkoutDateUTC(d.macrocycleDate, week, offset);
    const workouts = weekAcc.get(week) ?? [];
    workouts.push({ workoutNum, date: isoDate(date), skipped: skippedNums.has(workoutNum) });
    weekAcc.set(week, workouts);
  });

  const weeks: MacrocycleWeekSummary[] = [...weekAcc].map(([week, workouts]) => ({
    week,
    workouts,
    completed: workouts.every(
      (w) => completedWorkoutNums.has(w.workoutNum) || skippedNums.has(w.workoutNum),
    ),
  }));

  return {
    program: d.program,
    macrocycleNum: d.macrocycleNum,
    macrocycleStartDate: isoDate(d.macrocycleDate),
    weeks,
    currentWeekType,
    dateOverrides,
    skippedWorkoutNums: skippedList,
    completedWorkoutNums: completedList,
  };
}

/**
 * How a macrocycle's scheduled rows line up with its program's days (#1023): the rows
 * past the program's last day, which date no workout and which the dashboard leaves
 * out, and how many program days have no row and are dated spec-relatively. A macrocycle
 * scheduled since #1023 has neither, so either one marks a macrocycle scheduled before
 * it, or a program whose days changed mid-macrocycle.
 */
export function scheduleCoverage(
  program: string,
  spec: ReadonlyArray<{ week: WeekNumber; offset: number }>,
  scheduled: readonly ScheduledWorkout[],
): { pastLastDay: number[]; unscheduledDays: number } {
  const dayCount = programWorkoutKeys(program, spec).length;
  const rows = new Set(scheduled.map((sw) => sw.workoutNum));
  let unscheduledDays = 0;
  for (let workoutNum = 1; workoutNum <= dayCount; workoutNum++) {
    if (!rows.has(workoutNum)) unscheduledDays++;
  }
  return {
    pastLastDay: scheduled.map((sw) => sw.workoutNum).filter((n) => n > dayCount),
    unscheduledDays,
  };
}

export const toMacrocyclePlanResponse = (r: MacrocyclePlanResult): MacrocyclePlanResponse => ({
  proposedChanges: r.proposedChanges.map((c) => ({
    lift: c.lift,
    currentWeight: c.currentWeight,
    proposedWeight: c.proposedWeight,
    reasoning: c.reasoning,
  })),
  overallReasoning: r.overallReasoning,
  partial: r.partial,
  ...(r.partialReason !== undefined && { partialReason: r.partialReason }),
});

export const toLiftOverrideResponse = (o: LiftOverride): LiftOverrideResponse => ({
  action: o.action,
  lift: o.lift,
  ...(o.replacedBy !== undefined && { replacedBy: o.replacedBy }),
});

export const isValidWorkoutNum = (n: number): boolean =>
  Number.isInteger(n) && n >= 1;

/**
 * The `(week, offset)` workout-day key for a global `workoutNum`, or undefined when
 * `workoutNum` exceeds the program's canonical length. The stored spec is one
 * repeating block, so {@link programWorkoutKeys} first tiles it to the program's
 * canonical length; the `workoutNum` then indexes the ordered `(week, offset)`
 * workout days — the *same* numbering the web Macrocycle Dashboard grid
 * (`buildWorkoutDays`) and schedule generation use, so a card and the workout it
 * opens can never disagree on week, offset, or the spec-relative date derived from
 * them (issues #740, #745), in either mode (#1023). `program` defaults to the
 * base-spec block length for custom / unregistered programs.
 */
export const workoutKeyForWorkoutNum = (
  spec: LiftingProgramSpec[],
  workoutNum: number,
  program = '',
): { week: WeekNumber; offset: number } | undefined =>
  programWorkoutKeys(program, spec)[workoutNum - 1];

/**
 * Optional inputs to {@link toWorkoutResponse}. Collapsed into an options object
 * (issue #750) so call sites pass them by name — the two adjacent `Date` fields
 * (`scheduledDate`, `macrocycleStartDate`) can no longer be transposed without a
 * TypeScript error, the silent-wrong-date failure mode #749 fixed.
 */
export interface WorkoutResponseOptions {
  // Each field is `T | undefined` (not just `T?`): the pre-#750 positional params
  // these replace all accepted `undefined`, and the controller passes values that
  // may be undefined (`overrideDate ?? undefined`, `scheduledDate`, `macrocycleStartDate`,
  // `workoutKey?.offset`). Required under this workspace's `exactOptionalPropertyTypes`.
  /** User override date for the workout; surfaced as `overrideDate` on the response. */
  overrideDate?: Date | undefined;
  /** Spec-derived + override lift list; drives lift ordering, the `planned` flags and `replaces`. */
  plannedLifts?: readonly PlannedLift[] | undefined;
  /** System-assigned scheduled date (schedule mode). */
  scheduledDate?: Date | undefined;
  /** Whether the workout is explicitly skipped. */
  skipped?: boolean | undefined;
  /** Macrocycle start date; anchors the no-schedule spec-relative date. */
  macrocycleStartDate?: Date | undefined;
  /**
   * This workout's `(week, offset)` key offset; feeds the no-schedule date and is
   * emitted as `WorkoutResponse.offset`, so a client can resolve the day's spec
   * rows (issue #1014). `null` states that the program has no day for this
   * workout and is emitted as `null`. Leaving it out states nothing: the field is
   * omitted, which a client treats like an API that predates it.
   */
  offset?: number | null | undefined;
  /**
   * Stored lift name → the lift to group its records under, for `replace`
   * overrides. Applied while grouping rather than by renaming the records up
   * front, so each set's `id` is built from the record as persisted and still
   * addresses that row for `PATCH /lift-records/:id` (issue #978).
   */
  renamedLifts?: ReadonlyMap<string, string> | undefined;
}

/**
 * Groups a workout's lift records into the WorkoutResponse shape.
 * Caller must validate `workoutNum` with `isValidWorkoutNum` and resolve its day
 * with `workoutKeyForWorkoutNum` (the `week` and `offset` it passes) before invoking.
 *
 * When `plannedLifts` is provided (the spec-derived + override list), lifts are
 * emitted in that order, each keeping its `replaces` (the slot a swap took).
 * Planned-but-unlogged lifts appear with `sets: []` and
 * `planned: true`. Logged lifts not in the planned list are appended with
 * `planned: false`. When `plannedLifts` is omitted, all logged lifts are emitted
 * in record order with `planned: false` (preserves pre-override behaviour).
 *
 * The response `date` is the first logged record's date, else `scheduledDate`
 * (schedule mode), else — for a no-schedule unlogged workout — the spec-relative
 * date `macrocycleStart + (week-1)*7 + offset` derived from `macrocycleStartDate` + `offset`
 * (this workout's `(week, offset)` key offset, from `workoutKeyForWorkoutNum`) via
 * the shared {@link noScheduleWorkoutDateUTC}. That is the SAME date the Macrocycle
 * Dashboard card shows (`buildWorkoutDays` calls the same helper), so the card and
 * this detail page can never diverge (issue #745). Omitting `macrocycleStartDate` /
 * `offset` falls back to today only as a defensive last resort (e.g. no macrocycle
 * dashboard), which is what the pre-#745 code always did in no-schedule mode.
 */
export const toWorkoutResponse = (
  program: string,
  macrocycleNum: number,
  workoutNum: number,
  week: WeekNumber,
  records: LiftRecord[],
  options: WorkoutResponseOptions = {},
): WorkoutResponse => {
  const {
    overrideDate,
    plannedLifts,
    scheduledDate,
    skipped = false,
    macrocycleStartDate,
    offset,
    renamedLifts,
  } = options;

  const liftMap = new Map<string, SetResponse[]>();
  for (const r of records) {
    const set: SetResponse = {
      // From the record as stored — before the `renamedLifts` regrouping below —
      // so it is the id the persisted row answers to (issue #978).
      id: buildLiftRecordId(r.program, r),
      setNum: r.setNum,
      weight: r.weight,
      reps: r.reps,
      amrap: r.notes.toUpperCase().includes('AMRAP'),
      notes: r.notes,
    };
    const lift = renamedLifts?.get(r.lift) ?? r.lift;
    const sets = liftMap.get(lift);
    if (sets) sets.push(set);
    else liftMap.set(lift, [set]);
  }

  let lifts: WorkoutLiftResponse[];
  if (plannedLifts) {
    const emitted = new Set<string>();
    lifts = plannedLifts.map(({ lift, replaces }) => {
      emitted.add(lift);
      const sets = liftMap.get(lift) ?? [];
      return { lift, sets, planned: sets.length === 0, ...(replaces !== undefined && { replaces }) };
    });
    // Append any logged lifts not in the planned list (e.g. added ad-hoc during logging).
    for (const [lift, sets] of liftMap.entries()) {
      if (!emitted.has(lift)) {
        lifts.push({ lift, sets, planned: false });
      }
    }
  } else {
    lifts = Array.from(liftMap.entries()).map(([lift, sets]) => ({
      lift,
      sets,
      planned: false,
    }));
  }

  const date = records[0]
    ? isoDate(records[0].date)
    : scheduledDate
      ? isoDate(scheduledDate)
      : macrocycleStartDate !== undefined && typeof offset === 'number'
        ? isoDate(noScheduleWorkoutDateUTC(macrocycleStartDate, week, offset))
        : isoDate(new Date());
  return {
    program,
    macrocycleNum,
    workoutNum,
    week,
    ...(offset !== undefined && { offset }),
    date,
    ...(overrideDate !== undefined && { overrideDate: isoDate(overrideDate) }),
    skipped,
    lifts,
  };
};
