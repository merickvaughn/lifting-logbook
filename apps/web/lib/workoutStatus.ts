/**
 * Where a workout sits relative to today and what has been logged against it.
 *
 * Shared by the detail page and the timer page so the two cannot disagree about
 * whether a workout is still timeable: the detail page declines to mount the
 * timer for a completed or skipped workout, and the timer route has to make the
 * same call or it would happily hand out a full working timer for a session that
 * is already done.
 */
export type WorkoutStatus = 'completed' | 'upcoming' | 'missed' | 'skipped';

export function workoutStatus(date: string, hasLogs: boolean, skipped: boolean): WorkoutStatus {
  const today = new Date().toISOString().slice(0, 10);
  if (hasLogs) return 'completed';
  if (skipped) return 'skipped';
  if (date < today) return 'missed';
  return 'upcoming';
}

/** A completed or skipped workout has nothing left to time. */
export function isTimeable(status: WorkoutStatus): boolean {
  return status !== 'completed' && status !== 'skipped';
}

/** Status inputs, derived from a workout the API returned. */
export function statusOf(workout: {
  date: string;
  overrideDate?: string | null;
  skipped: boolean;
  lifts: { planned?: boolean }[];
}): WorkoutStatus {
  const effectiveDate = workout.overrideDate ?? workout.date;
  const hasLogs = workout.lifts.some((l) => !l.planned);
  return workoutStatus(effectiveDate, hasLogs, workout.skipped);
}
