import {
  CycleDashboard,
  LiftRecord,
  LiftingProgramSpec,
  StrengthGoalEntry,
  TrainingMax,
  TrainingMaxHistoryEntry,
  buildLiftRecordId,
  expandSpecToLength,
  normalizeAmrap,
  noScheduleWorkoutDateUTC,
  orderedWorkoutKeys,
  programLengthWeeks,
} from '@lifting-logbook/core';
import {
  CycleDashboardResponse,
  CyclePlanResponse,
  CycleWeekSummary,
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
import { CyclePlanResult } from '../ports/ICyclePlanningAgent';
import { ScheduledWorkout } from '../ports/ICycleScheduledWorkoutRepository';
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
  cycleNum: r.cycleNum,
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
 * Maps a CycleDashboard to a CycleDashboardResponse with no schedule data.
 * Used when no scheduled workouts exist (no-schedule mode).
 *
 * `currentWeekType` is passed explicitly because it is derived at request time
 * via `weekTypeForDate(dashboard.cycleDate, programSpec)`, not stored on the
 * dashboard model.
 */
export const toCycleDashboardResponse = (
  d: CycleDashboard,
  currentWeekType: WeekType,
  dateOverrides: Record<number, string> = {},
  skippedWorkoutNums: number[] = [],
  completedWorkoutNums: number[] = [],
): CycleDashboardResponse => ({
  program: d.program,
  cycleNum: d.cycleNum,
  cycleStartDate: isoDate(d.cycleDate),
  weeks: [],
  currentWeekType,
  dateOverrides,
  skippedWorkoutNums,
  completedWorkoutNums,
});

/**
 * Builds a CycleDashboardResponse with per-week summaries derived from scheduled
 * workout dates. When an override date exists for a workout it wins over the
 * system-assigned scheduled date. A week is marked completed when every workout
 * in that week has at least one lift record or is explicitly skipped.
 */
export function buildCycleDashboardResponse(
  d: CycleDashboard,
  currentWeekType: WeekType,
  scheduled: ScheduledWorkout[],
  overrides: Map<number, Date>,
  completedWorkoutNums: Set<number>,
  skippedNums: Set<number> = new Set(),
): CycleDashboardResponse {
  // Per-workout metadata for the whole cycle, surfaced top-level so the Cycle
  // Dashboard can render every tiled workout's status without a per-workout fetch
  // (issue #740). Populated identically in both modes; only `weeks` differs.
  const dateOverrides: Record<number, string> = {};
  for (const [workoutNum, date] of overrides) {
    dateOverrides[workoutNum] = isoDate(date);
  }
  const skippedList = [...skippedNums].sort((a, b) => a - b);
  const completedList = [...completedWorkoutNums].sort((a, b) => a - b);

  if (scheduled.length === 0) {
    return toCycleDashboardResponse(
      d,
      currentWeekType,
      dateOverrides,
      skippedList,
      completedList,
    );
  }

  const weekAcc = new Map<number, { workouts: WorkoutSummary[]; scheduled: ScheduledWorkout[] }>();
  for (const sw of scheduled) {
    const effectiveDate = overrides.get(sw.workoutNum) ?? sw.scheduledDate;
    const acc = weekAcc.get(sw.weekNum) ?? { workouts: [], scheduled: [] };
    acc.workouts.push({
      workoutNum: sw.workoutNum,
      date: isoDate(effectiveDate),
      skipped: skippedNums.has(sw.workoutNum),
    });
    acc.scheduled.push(sw);
    weekAcc.set(sw.weekNum, acc);
  }

  const weeks: CycleWeekSummary[] = [...weekAcc.keys()]
    .sort((a, b) => a - b)
    .map((weekNum) => {
      const { workouts, scheduled } = weekAcc.get(weekNum)!;
      return {
        week: weekNum as WeekNumber,
        workouts,
        completed: scheduled.every(
          (sw) => completedWorkoutNums.has(sw.workoutNum) || skippedNums.has(sw.workoutNum),
        ),
      };
    });

  return {
    program: d.program,
    cycleNum: d.cycleNum,
    cycleStartDate: isoDate(d.cycleDate),
    weeks,
    currentWeekType,
    dateOverrides,
    skippedWorkoutNums: skippedList,
    completedWorkoutNums: completedList,
  };
}

export const toCyclePlanResponse = (r: CyclePlanResult): CyclePlanResponse => ({
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

/**
 * Applies a list of lift overrides to the spec-derived planned lift list.
 * - 'remove': drops the lift from the list.
 * - 'replace': swaps the lift in-place, preserving order.
 * - 'add': appends the lift if not already present.
 */
export function applyLiftOverrides(specLifts: string[], overrides: LiftOverride[]): string[] {
  let lifts = [...specLifts];
  for (const o of overrides) {
    if (o.action === 'remove') {
      lifts = lifts.filter((l) => l !== o.lift);
    } else if (o.action === 'replace' && o.replacedBy) {
      lifts = lifts.map((l) => (l === o.lift ? o.replacedBy! : l));
    } else if (o.action === 'add') {
      if (!lifts.includes(o.lift)) lifts.push(o.lift);
    }
  }
  return lifts;
}

export const isValidWorkoutNum = (n: number): boolean =>
  Number.isInteger(n) && n >= 1;

/**
 * The `(week, offset)` workout-day key for a global `workoutNum`, or undefined when
 * `workoutNum` exceeds the program's canonical length. The stored spec is one
 * repeating block, so it is first tiled to the program's canonical length
 * ({@link expandSpecToLength} + {@link programLengthWeeks}); the `workoutNum` then
 * indexes into the ordered `(week, offset)` workout days ({@link orderedWorkoutKeys})
 * — the *same* mapping the web Cycle Dashboard grid (`buildWorkoutDays`) uses, so a
 * card and the workout it opens can never disagree on week, offset, or the
 * spec-relative date derived from them (issues #740, #745). `program` defaults to
 * the base-spec block length for custom / unregistered programs.
 */
export const workoutKeyForWorkoutNum = (
  spec: LiftingProgramSpec[],
  workoutNum: number,
  program = '',
): { week: WeekNumber; offset: number } | undefined => {
  const fullSpec = expandSpecToLength(spec, programLengthWeeks(program, spec));
  return orderedWorkoutKeys(fullSpec)[workoutNum - 1];
};

/**
 * The training week for a global `workoutNum` — the no-schedule fallback (a
 * scheduled row's `weekNum` is authoritative when present). A thin `.week` accessor
 * over {@link workoutKeyForWorkoutNum}; see it for the tiling contract.
 *
 * Returns undefined only when `workoutNum` exceeds the *full* canonical length
 * (surfaced as 400 by the controller). Before #740 the cap was one block's
 * distinct-offset count, which 400'd every week-2+ workout of a tiled program in
 * no-schedule mode (#680 fixed this only for schedule mode).
 */
export const weekForWorkoutNum = (
  spec: LiftingProgramSpec[],
  workoutNum: number,
  program = '',
): WeekNumber | undefined => workoutKeyForWorkoutNum(spec, workoutNum, program)?.week;

/**
 * Optional inputs to {@link toWorkoutResponse}. Collapsed into an options object
 * (issue #750) so call sites pass them by name — the two adjacent `Date` fields
 * (`scheduledDate`, `cycleStartDate`) can no longer be transposed without a
 * TypeScript error, the silent-wrong-date failure mode #749 fixed.
 */
export interface WorkoutResponseOptions {
  // Each field is `T | undefined` (not just `T?`): the pre-#750 positional params
  // these replace all accepted `undefined`, and the controller passes values that
  // may be undefined (`overrideDate ?? undefined`, `scheduledDate`, `cycleStartDate`,
  // `workoutKey?.offset`). Required under this workspace's `exactOptionalPropertyTypes`.
  /** User override date for the workout; surfaced as `overrideDate` on the response. */
  overrideDate?: Date | undefined;
  /** Spec-derived + override lift list; drives lift ordering and the `planned` flags. */
  plannedLifts?: string[] | undefined;
  /** System-assigned scheduled date (schedule mode). */
  scheduledDate?: Date | undefined;
  /** Whether the workout is explicitly skipped. */
  skipped?: boolean | undefined;
  /** Cycle start date; anchors the no-schedule spec-relative date. */
  cycleStartDate?: Date | undefined;
  /** This workout's `(week, offset)` key offset; feeds the no-schedule date. */
  offset?: number | undefined;
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
 * Caller must validate `workoutNum` with `isValidWorkoutNum` and derive
 * `week` via `weekForWorkoutNum` before invoking.
 *
 * When `plannedLifts` is provided (the spec-derived + override list), lifts are
 * emitted in that order. Planned-but-unlogged lifts appear with `sets: []` and
 * `planned: true`. Logged lifts not in the planned list are appended with
 * `planned: false`. When `plannedLifts` is omitted, all logged lifts are emitted
 * in record order with `planned: false` (preserves pre-override behaviour).
 *
 * The response `date` is the first logged record's date, else `scheduledDate`
 * (schedule mode), else — for a no-schedule unlogged workout — the spec-relative
 * date `cycleStart + (week-1)*7 + offset` derived from `cycleStartDate` + `offset`
 * (this workout's `(week, offset)` key offset, from `workoutKeyForWorkoutNum`) via
 * the shared {@link noScheduleWorkoutDateUTC}. That is the SAME date the Cycle
 * Dashboard card shows (`buildWorkoutDays` calls the same helper), so the card and
 * this detail page can never diverge (issue #745). Omitting `cycleStartDate` /
 * `offset` falls back to today only as a defensive last resort (e.g. no cycle
 * dashboard), which is what the pre-#745 code always did in no-schedule mode.
 */
export const toWorkoutResponse = (
  program: string,
  cycleNum: number,
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
    cycleStartDate,
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
    lifts = plannedLifts.map((lift) => {
      emitted.add(lift);
      const sets = liftMap.get(lift) ?? [];
      return { lift, sets, planned: sets.length === 0 };
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
      : cycleStartDate !== undefined && offset !== undefined
        ? isoDate(noScheduleWorkoutDateUTC(cycleStartDate, week, offset))
        : isoDate(new Date());
  return {
    program,
    cycleNum,
    workoutNum,
    week,
    date,
    ...(overrideDate !== undefined && { overrideDate: isoDate(overrideDate) }),
    skipped,
    lifts,
  };
};
