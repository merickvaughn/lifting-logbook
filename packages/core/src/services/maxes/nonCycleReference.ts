import type { WeightUnit } from "@lifting-logbook/types";
import { currentMaxLookup, isSameLift } from "../../catalog/liftIdentity";
import type { LiftRecord, TrainingMax, TrainingMaxHistoryEntry } from "../../models";
import { formatWeight } from "../../utils/weightUnit";

/**
 * What a non-cycle workout shows beside a lift for reference (proposal 2026-11-06, decision 23):
 * the lift's training max in the active program and, when one is known, the previous max with
 * the reps last performed at it. Weights are in the stored unit, pounds.
 */
export interface NonCycleReference {
  trainingMax: number;
  previous: { weight: number; reps: number } | null;
}

export interface NonCycleReferenceInput {
  lift: string;
  /** The active program's current training maxes. */
  trainingMaxes: readonly TrainingMax[];
  /** The active program's training max history. */
  history: readonly Pick<TrainingMaxHistoryEntry, "lift" | "weight" | "date">[];
  /** The lifter's sets of the lift, under any program and any spelling. */
  sets: readonly Pick<LiftRecord, "lift" | "weight" | "reps" | "date" | "workoutNum" | "occurrence" | "setNum">[];
}

/** Two decimal places, as `buildHistoryEntries` compares a changed max. */
function round2dp(weight: number): number {
  return Math.round(weight * 100) / 100;
}

/**
 * The reference for `lift`, or null when the active program has no training max for it.
 *
 * - The previous max is the newest history entry for the lift whose weight differs from the
 *   current max at two decimal places.
 * - Its reps come from the most recent set at exactly that weight, under any program, with the
 *   lift matched by any spelling of it. Ties go to the latest date, then the highest workout
 *   number, then the lowest occurrence, then the lowest set number.
 * - With no previous max, or no set at it, `previous` is null and the max shows alone.
 */
export function nonCycleReference({ lift, trainingMaxes, history, sets }: NonCycleReferenceInput): NonCycleReference | null {
  const max = currentMaxLookup(trainingMaxes)(lift);
  if (!max) return null;
  const current = round2dp(max.weight);
  const previousMax = history
    .filter((entry) => isSameLift(entry.lift, lift) && round2dp(entry.weight) !== current)
    .reduce<NonCycleReferenceInput["history"][number] | undefined>(
      (newest, entry) => (!newest || new Date(entry.date) >= new Date(newest.date) ? entry : newest),
      undefined,
    );
  if (!previousMax) return { trainingMax: max.weight, previous: null };

  const last = sets
    .filter((set) => isSameLift(set.lift, lift) && set.weight === previousMax.weight)
    .sort(
      (a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime() ||
        b.workoutNum - a.workoutNum ||
        (a.occurrence ?? 0) - (b.occurrence ?? 0) ||
        a.setNum - b.setNum,
    )[0];
  return {
    trainingMax: max.weight,
    previous: last ? { weight: previousMax.weight, reps: last.reps } : null,
  };
}

/**
 * The reference as one line in the lifter's unit, such as
 * "Training max 205 lbs. Last at 200 lbs: 8 reps.", or the max alone with no previous set.
 */
export function formatNonCycleReference(reference: NonCycleReference, unit: WeightUnit): string {
  const max = `Training max ${formatWeight(reference.trainingMax, "lbs", unit)}.`;
  const { previous } = reference;
  if (!previous) return max;
  const reps = `${previous.reps} ${previous.reps === 1 ? "rep" : "reps"}`;
  return `${max} Last at ${formatWeight(previous.weight, "lbs", unit)}: ${reps}.`;
}
