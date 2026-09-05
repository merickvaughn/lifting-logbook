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

/**
 * Completed wins over skipped, intentionally: a partially-logged workout can also
 * be marked skipped, because the two are independent records. When both are true
 * the workout still reads as completed, and the detail page hides its SkipForm.
 */
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

/**
 * The date a workout actually falls on: the reschedule override, else its
 * original date. The one owner of that rule — `statusOf` judges against it and
 * the detail page displays it, so a second copy could put the two out of step.
 */
export function effectiveDateOf(workout: { date: string; overrideDate?: string | null }): string {
  return workout.overrideDate ?? workout.date;
}

/** Status inputs, derived from a workout the API returned. */
export function statusOf(workout: {
  date: string;
  overrideDate?: string | null;
  skipped: boolean;
  lifts: { planned?: boolean }[];
}): WorkoutStatus {
  const hasLogs = workout.lifts.some((l) => !l.planned);
  return workoutStatus(effectiveDateOf(workout), hasLogs, workout.skipped);
}
