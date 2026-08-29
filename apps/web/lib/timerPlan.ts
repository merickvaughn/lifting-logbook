import { formatWeight } from '@lifting-logbook/core';
import type { TimerLiftPlan } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import type { PlannedSet } from './workoutPlan';

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
 */
export function toTimerLiftPlans(
  details: readonly TimerPlanInput[],
  unit: WeightUnit,
): TimerLiftPlan[] {
  return details
    .filter((detail) => detail.plannedSets.length > 0)
    .map((detail) => ({
      lift: detail.lift,
      tm: detail.tm > 0 ? `TM: ${formatWeight(detail.tm, 'lbs', unit)}` : undefined,
      sets: detail.plannedSets.map((set) => ({
        type: set.type,
        setLabel: set.setLabel,
        spec: `${set.reps} × ${formatWeight(set.weight, 'lbs', unit)}`,
      })),
    }));
}
