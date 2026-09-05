import 'server-only';

import type { TimerLiftPlan } from '@lifting-logbook/core';
import type { WeightUnit, WorkoutResponse } from '@lifting-logbook/types';
import { fetchCustomLifts, fetchProgramSpec, fetchTrainingMaxes, fetchWorkout } from '@/lib/api';
import { getPreferredUnit } from '@/lib/preferences';
import { CUSTOM_LIFTS_TIMEOUT_MS, toTimerLiftPlans } from '@/lib/timerPlan';
import { withTimeout } from '@/lib/with-timeout';
import { buildLiftDetails } from '@/lib/workoutPlan';
import type { WorkoutLiftDetail } from '@/lib/workoutPlan';
import { statusOf } from '@/lib/workoutStatus';
import type { WorkoutStatus } from '@/lib/workoutStatus';

/**
 * Everything the workout-detail and timer pages derive from one workout.
 *
 * The two routes are halves of one session — the dock on the detail page and the
 * dial on the timer page count down the *same* plan — so the plan is computed in
 * exactly one place (issue #984). Before this, each page carried its own copy of
 * the same ~30-line fetch-and-compute block, with a comment asking them to stay
 * identical; now they cannot drift because there is nothing to keep in step.
 */
export interface WorkoutPlan {
  workout: WorkoutResponse;
  unit: WeightUnit;
  status: WorkoutStatus;
  /**
   * One entry per `workout.lifts` entry, in order — position is a lift's
   * identity for the timer (ADR-035 Amendment 4), so nothing here filters.
   */
  liftDetails: WorkoutLiftDetail[];
  /**
   * The timer's plan, with each lift classified. Deferred behind a call: the
   * custom-lift fetch that classification needs is started before the load-
   * bearing fetches but only *awaited* here, so a page that decides not to
   * mount the timer (a completed workout — most detail-page views) never puts
   * that round-trip on its critical path.
   */
  timerLifts: () => Promise<TimerLiftPlan[]>;
}

/**
 * Loads a workout and its plan, or `null` when the workout does not exist.
 *
 * `notFound()` / `redirect()` are the page's call, not this loader's — keeping
 * `next/navigation` out of here is what lets the loader be tested as a plain
 * function.
 */
export async function loadWorkoutPlan(
  program: string,
  workoutNum: number,
): Promise<WorkoutPlan | null> {
  // Bounded and caught, unlike its four siblings: this one only enriches the
  // accessory classification of the user's *own* lifts, so neither a failure nor
  // a slow response may take down — or hold up — a timer the lifter is standing
  // in the gym waiting on. The other four are load-bearing and keep their
  // fail-fast behavior.
  //
  // The timeout is separate from the api-client's own `AbortSignal.timeout(30s)`:
  // that is a failure bound, and 30s of blocked first paint for an optional
  // enrichment is not a useful outcome. `onTimeout` logs distinctly so "slow"
  // and "down" stay tellable apart in the logs. Started here, awaited only by
  // `timerLifts()` — see `WorkoutPlan.timerLifts`.
  // fallback-covered-by: apps/web/lib/__tests__/loadWorkoutPlan.test.ts
  const customLiftsPromise = withTimeout(
    fetchCustomLifts().catch((err: unknown) => {
      console.error('[loadWorkoutPlan] custom lifts fetch failed, classifying built-ins only', err);
      return [];
    }),
    CUSTOM_LIFTS_TIMEOUT_MS,
    [],
    () => console.warn('[loadWorkoutPlan] custom lifts fetch slow, classifying built-ins only'),
  );

  const [workout, specs, maxes, unit] = await Promise.all([
    fetchWorkout(program, workoutNum),
    fetchProgramSpec(program),
    fetchTrainingMaxes(program),
    getPreferredUnit(),
  ]);

  if (!workout) return null;

  const liftDetails = buildLiftDetails(workout, specs, maxes);

  return {
    workout,
    unit,
    status: statusOf(workout),
    liftDetails,
    timerLifts: async () => toTimerLiftPlans(liftDetails, unit, await customLiftsPromise),
  };
}
