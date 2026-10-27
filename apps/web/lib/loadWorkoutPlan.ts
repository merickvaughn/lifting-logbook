import 'server-only';

import type { TimerLiftPlan } from '@lifting-logbook/core';
import { FOCUS_PLACEMENTS, FOCUS_PROGRESSIONS } from '@lifting-logbook/types';
import type { FocusDayPlanResponse, WeightUnit, WorkoutResponse } from '@lifting-logbook/types';
import { fetchCustomLifts, fetchFocusPlan, fetchProgramSpec, fetchTrainingMaxes, fetchWorkout } from '@/lib/api';
import { getPreferredUnit } from '@/lib/preferences';
import { CUSTOM_LIFTS_TIMEOUT_MS, toTimerLiftPlans } from '@/lib/timerPlan';
import { withTimeout } from '@/lib/with-timeout';
import { buildLiftDetails } from '@/lib/workoutPlan';
import type { WorkoutLiftDetail } from '@/lib/workoutPlan';
import { effectiveDateOf, statusOf } from '@/lib/workoutStatus';
import type { WorkoutStatus } from '@/lib/workoutStatus';

type CustomLifts = Promise<Awaited<ReturnType<typeof fetchCustomLifts>>>;

/**
 * Which route asked for the plan.
 *
 * Threaded into the two custom-lift degradation log lines. `apps/web` has no
 * structured server logger and no `trace_id` on its console output, so the
 * message prefix is the only field carrying provenance — and the two routes
 * degrade very differently: the detail page loses a dock's rest-duration
 * accuracy, while the timer page is a lifter standing in the gym. Before #984
 * each page owned its own copy of these lines and named itself; the shared
 * loader has to be told.
 */
export type WorkoutPlanCaller = 'WorkoutDetailPage' | 'WorkoutTimerPage';

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
   * The date the workout actually falls on — the reschedule override when there
   * is one. Carried here so the page renders the same date `statusOf` judged the
   * status against; recomputing `overrideDate ?? date` at the call site let the
   * two drift.
   */
  effectiveDate: string;
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
   * that round-trip on its critical path. The slow-fetch budget arms here too,
   * on first call, so a page that never mounts the timer cannot log a
   * degradation it never experienced.
   *
   * `focus` is the day's focus work from {@link loadFocusPlan}, or `null` for none;
   * its lifts join the plan in placement order (#1060). It may be passed still in
   * flight, so the custom-lift budget and the focus fetch run side by side.
   */
  timerLifts: (
    focus: FocusDayPlanResponse | null | Promise<FocusDayPlanResponse | null>,
  ) => Promise<TimerLiftPlan[]>;
}

/** Which route asked for the day's focus work. */
export type FocusPlanCaller = WorkoutPlanCaller | 'WorkoutLoggingPage';

/** The day's focus work, or `null`: none active, or the fetch `failed`. */
export interface FocusPlanResult {
  plan: FocusDayPlanResponse | null;
  failed: boolean;
}

/**
 * How long the workout pages wait for the day's focus plan before showing planned lifts
 * only. A latency budget, like {@link CUSTOM_LIFTS_TIMEOUT_MS}: focus work is optional on
 * all three pages, and the logging and timer pages are opened mid-session. Longer than
 * that one because the API plans the day on this request rather than reading a list.
 */
export const FOCUS_PLAN_TIMEOUT_MS = 3000;

/**
 * Whether every value the pages switch on is one this build knows. The API ships before
 * the web, so a newer placement or progression would otherwise throw while rendering
 * (`workoutOrder`, `describePrescription`) instead of falling back.
 */
function isKnownShape(plan: FocusDayPlanResponse): boolean {
  return (
    FOCUS_PLACEMENTS.includes(plan.dayState.placement) &&
    plan.groups.every((group) =>
      group.items.every((item) => FOCUS_PROGRESSIONS.includes(item.prescription.progression)),
    )
  );
}

/**
 * Loads one workout's focus work for the server's calendar day (UTC for now, #1072).
 *
 * Shared by the details, timer and logging pages so all three list the same focus lifts
 * in the same order. A failed, slow or unrecognised plan is not fatal: the caller falls
 * back to the planned lifts, and the details page says so. A plan with no active focus
 * block reads as `null`.
 */
export async function loadFocusPlan(
  program: string,
  workoutNum: number,
  caller: FocusPlanCaller,
): Promise<FocusPlanResult> {
  const failed: FocusPlanResult = { plan: null, failed: true };
  // fallback-covered-by: apps/web/lib/__tests__/loadWorkoutPlan.test.ts
  const loaded = fetchFocusPlan(program, workoutNum, new Date().toISOString().slice(0, 10)).then(
    (plan): FocusPlanResult => {
      if (!isKnownShape(plan)) {
        console.error(`[${caller}] focus plan has a placement or progression this build doesn’t know, showing planned lifts only`);
        return failed;
      }
      return { plan: plan.groups.length > 0 ? plan : null, failed: false };
    },
    (err: unknown): FocusPlanResult => {
      console.error(`[${caller}] focus plan fetch failed, showing planned lifts only`, err);
      return failed;
    },
  );
  return withTimeout(loaded, FOCUS_PLAN_TIMEOUT_MS, failed, () =>
    console.warn(`[${caller}] focus plan fetch slow, showing planned lifts only`),
  );
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
  caller: WorkoutPlanCaller,
): Promise<WorkoutPlan | null> {
  // Bounded and caught, unlike its four siblings: this one only enriches the
  // accessory classification of the user's *own* lifts, so neither a failure nor
  // a slow response may take down — or hold up — a timer the lifter is standing
  // in the gym waiting on. The other four are load-bearing and keep their
  // fail-fast behavior.
  //
  // The fetch starts here so it overlaps the load-bearing four, but the *budget*
  // is armed only inside `boundedCustomLifts()` below. `withTimeout` calls
  // `setTimeout` synchronously in its executor, so arming it here would start a
  // 1500 ms timer on every call — including the three paths that never consume
  // the result (`notFound()`, the timer route's `redirect()`, and a completed or
  // skipped detail view, which is *most* detail-page traffic). A slow
  // `/lifts/custom` would then log "slow, classifying built-ins only" on the
  // app's most-visited route, asserting a degradation that never reached a
  // rendered output.
  // fallback-covered-by: apps/web/lib/__tests__/loadWorkoutPlan.test.ts
  const customLiftsPromise = fetchCustomLifts().catch((err: unknown) => {
    console.error(`[${caller}] custom lifts fetch failed, classifying built-ins only`, err);
    return [];
  });

  // The timeout is separate from the api-client's own `AbortSignal.timeout(30s)`:
  // that is a failure bound, and 30s of blocked first paint for an optional
  // enrichment is not a useful outcome. `onTimeout` logs distinctly so "slow"
  // and "down" stay tellable apart in the logs. Memoized so a second
  // `timerLifts()` call cannot arm a second budget.
  // fallback-covered-by: apps/web/lib/__tests__/loadWorkoutPlan.test.ts
  let bounded: CustomLifts | undefined;
  const boundedCustomLifts = (): CustomLifts =>
    (bounded ??= withTimeout(
      customLiftsPromise,
      CUSTOM_LIFTS_TIMEOUT_MS,
      [],
      () => console.warn(`[${caller}] custom lifts fetch slow, classifying built-ins only`),
    ));

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
    effectiveDate: effectiveDateOf(workout),
    liftDetails,
    timerLifts: async (focus) => {
      const [customLifts, focusPlan] = await Promise.all([boundedCustomLifts(), focus]);
      return toTimerLiftPlans(liftDetails, unit, customLifts, focusPlan);
    },
  };
}
