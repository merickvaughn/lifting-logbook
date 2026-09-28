import { UserWorkoutSchedule } from "@lifting-logbook/types";
import { addDaysLocal } from "@src/core/utils/jsUtil";

export interface DistributedWeek {
  week: number;
  workouts: Date[];
}

// Backs a date up to the Monday of its week. Uses local time to match addDaysLocal.
// JS Date.getDay() returns 0=Sun … 6=Sat; the project encodes 0=Mon … 6=Sun via DAY_INDEX.
// (jsDay + 6) % 7 converts: Sun(0)→6, Mon(1)→0, Tue(2)→1, …
function alignToMonday(date: Date): Date {
  const base = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offsetFromMonday = (base.getDay() + 6) % 7;
  return addDaysLocal(base, -offsetFromMonday);
}

// `UserWorkoutSchedule` keeps `days` and `weeks` as optional on a single interface
// (not a discriminated union), so the `?? []` fallbacks are required for type
// soundness even though the runtime validator (`isValidSchedule`) guarantees the
// correct arm is populated at the API boundary.
//
// Sorted into weekday order: the validator accepts days in any order, and a
// week listed as [Fri, Mon] must still date its first workout on the Monday.
// Callers number workouts by position, so the dates must come out chronological
// (issue #1023).
function getWeekPattern(
  schedule: UserWorkoutSchedule,
  weekIndex: number,
): number[] {
  let days: number[];
  if (schedule.type === "fixed") {
    days = schedule.days ?? [];
  } else {
    const weeks = schedule.weeks ?? [];
    days = weeks.length === 0 ? [] : (weeks[weekIndex % weeks.length] ?? []);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Distributes a fixed number of workouts across weeks according to a user schedule.
 *
 * The first week is aligned to the Monday of `cycleStartDate`'s week; days earlier in
 * that week than the start date are still emitted, matching the design-doc contract
 * (callers wanting "future days only" should filter the first week themselves).
 *
 * Dates come out in chronological order, each week's days in weekday order however
 * the schedule lists them, so the Nth date is the Nth workout.
 *
 * Returns an empty array when the schedule has no usable days (e.g. an empty fixed
 * `days` array or rotating with all-empty weeks) — guards against infinite loops.
 *
 * The `week` field is a sequential 1-based counter for non-empty weeks; for rotating
 * schedules with empty interior week patterns, the counter advances over skipped
 * weeks, so `result[i].week` may not equal `i + 1`. Callers using `week` as an array
 * index should compute their own positional index instead.
 *
 * Throws on negative `cycleWorkouts` so caller bugs surface here rather than as
 * silent empty output downstream.
 */
export function distributeWorkouts(
  cycleWorkouts: number,
  schedule: UserWorkoutSchedule,
  cycleStartDate: Date,
): DistributedWeek[] {
  if (cycleWorkouts < 0) {
    throw new Error(
      `distributeWorkouts: cycleWorkouts must be non-negative (got ${cycleWorkouts})`,
    );
  }
  if (cycleWorkouts === 0) return [];

  // Guard against schedules with no placeable days — without this, the while loop
  // below would spin forever advancing weekCounter without placing anything.
  const hasAnyDays =
    schedule.type === "fixed"
      ? (schedule.days?.length ?? 0) > 0
      : (schedule.weeks ?? []).some((w) => w.length > 0);
  if (!hasAnyDays) return [];

  const distribution: DistributedWeek[] = [];
  let workoutsPlaced = 0;
  let weekCounter = 0;
  let currentWeekStart = alignToMonday(cycleStartDate);

  while (workoutsPlaced < cycleWorkouts) {
    const weekPattern = getWeekPattern(schedule, weekCounter);
    const weekWorkouts: Date[] = [];

    for (const dayIndex of weekPattern) {
      if (workoutsPlaced >= cycleWorkouts) break;
      weekWorkouts.push(addDaysLocal(currentWeekStart, dayIndex));
      workoutsPlaced++;
    }

    if (weekWorkouts.length > 0) {
      distribution.push({ week: weekCounter + 1, workouts: weekWorkouts });
    }

    currentWeekStart = addDaysLocal(currentWeekStart, 7);
    weekCounter++;
  }

  return distribution;
}

/**
 * Estimated workouts per week for a schedule. Used only for cycle-duration display —
 * the schedule itself drives distribution, not this number.
 *
 * Fixed → number of training days. Rotating → rounded average across week patterns.
 */
export function getScheduleWorkoutsPerWeek(
  schedule: UserWorkoutSchedule,
): number {
  if (schedule.type === "fixed") return (schedule.days ?? []).length;
  const weeks = schedule.weeks ?? [];
  if (weeks.length === 0) return 0;
  const total = weeks.reduce((sum, w) => sum + w.length, 0);
  return Math.round(total / weeks.length);
}
