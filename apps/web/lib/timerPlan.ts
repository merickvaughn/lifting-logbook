import { formatWeight, liftClassificationFor } from '@lifting-logbook/core';
import type { ClassifiableLift, TimerLiftPlan } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import type { PlannedSet } from './workoutPlan';

/**
 * How long the workout pages wait for the custom-lift list before rendering
 * without it.
 *
 * A latency budget, not a failure bound — the api-client already carries
 * `AbortSignal.timeout(30_000)` for the latter, and 30s of blocked first paint
 * for an optional enrichment is not a useful outcome on the two pages a lifter
 * opens mid-session. Sized like `getGcpIdentityToken`'s bound: generous for a
 * single small authenticated GET, short enough to be invisible when it trips.
 */
export const CUSTOM_LIFTS_TIMEOUT_MS = 1500;

/**
 * The slice of a workout-detail lift the timer needs.
 *
 * Structurally satisfied by the `liftDetails` entries both the detail page and
 * the timer page already build from `computePlannedSets`, so neither has to
 * assemble a second shape.
 */
export interface TimerPlanInput {
  lift: string;
  /** Training max in lbs — the storage unit; `unit` is display only. */
  tm: number;
  plannedSets: PlannedSet[];
}

/**
 * Maps planned sets into the timer's own domain shape.
 *
 * This is the boundary that keeps `packages/core` free of any `apps/web` type:
 * the core queue builder takes `TimerLiftPlan`, and this is the only place that
 * knows how to produce one. Weights are formatted here rather than in the timer
 * because `spec` is display copy — the timer never does arithmetic on it.
 *
 * Lifts with no planned sets are dropped: they appear in the list as "set a
 * training max to see planned weights", and queueing a lift with nothing to
 * perform would emit rest phases for a set that never happens.
 *
 * Training role is resolved here too, rather than being carried on
 * {@link TimerPlanInput}: the detail and timer pages build their `liftDetails`
 * lists independently, so putting the lookup on the input shape would duplicate
 * it across both call sites instead of keeping it at the one mapping boundary.
 *
 * @param customLifts - The user's own lifts, so their classification is available
 *   alongside the built-in catalog's. Required rather than defaulted, for the same
 *   reason `resolveDuration`'s `classification` is: a default would let a call site
 *   added later opt out by omission, compiling clean while silently declassifying
 *   every custom lift. Pass `[]` where there is genuinely no list — a caller whose
 *   fetch failed still gets every built-in catalog lift classified.
 */
export function toTimerLiftPlans(
  details: readonly TimerPlanInput[],
  unit: WeightUnit,
  customLifts: readonly ClassifiableLift[],
): TimerLiftPlan[] {
  return details
    .filter((detail) => detail.plannedSets.length > 0)
    .map((detail) => ({
      lift: detail.lift,
      classification: liftClassificationFor(detail.lift, customLifts),
      tm: detail.tm > 0 ? `TM: ${formatWeight(detail.tm, 'lbs', unit)}` : undefined,
      sets: detail.plannedSets.map((set) => ({
        type: set.type,
        setLabel: set.setLabel,
        spec: `${set.reps} × ${formatWeight(set.weight, 'lbs', unit)}`,
      })),
    }));
}
