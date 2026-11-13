import type { LiftModificationMaxMode } from "@lifting-logbook/types";
import { floorToIncrement } from "@src/core/constants";
import { currentMaxLookup, liftIdFor } from "../../catalog/liftIdentity";
import type { LiftRecord, TrainingMax } from "../../models";
import { estimateOneRepMax, MAX_ESTIMATE_REPS } from "./estimateOneRepMax";
import { movesLiftMax } from "./updateMaxes";

/** How far back from a lift's latest set the estimate looks (#1246; revisit with #1275). */
export const MISSING_MAX_ESTIMATE_WEEKS = 8;

/**
 * The training max for a one-rep max: 90% of it, floored to the estimate increment. Onboarding's
 * "Estimate from a recent lift" and the missing-max estimate both use it, so they give one number.
 */
export function trainingMaxFromOneRepMax(oneRepMax: number): number {
  return floorToIncrement(oneRepMax * 0.9);
}

const DAY_MS = 86_400_000;

type EstimateSet = Pick<LiftRecord, "date" | "weight" | "reps">;

/** A starting training max, and the set it came from. Weights are in the stored unit, pounds. */
export interface TrainingMaxEstimate {
  weight: number;
  from: { date: Date; weight: number; reps: number };
}

/** A lift with logged sets and no training max (#1246). */
export interface MissingTrainingMax {
  /** The lift as its latest set names it; on a tie, the name first in sort order. */
  lift: string;
  /** Its stable id (`liftIdFor`, #1139): what a dismissal is keyed by. */
  liftId: string;
  setCount: number;
  lastLoggedDate: Date;
  estimate: TrainingMaxEstimate | null;
}

export interface MissingTrainingMaxesInput {
  /** The program's training maxes. */
  trainingMaxes: readonly Pick<TrainingMax, "lift" | "dateUpdated">[];
  /** The program's sets. Those of lifts that have a max, or that `lifts` leaves out, are ignored. */
  records: readonly Pick<LiftRecord, "lift" | "date" | "weight" | "reps" | "modifications" | "occurrence">[];
  /** The `maxMode` of each modification the records name, as `updateMaxes` takes them (#1152). */
  modificationModes: ReadonlyMap<string, LiftModificationMaxMode>;
  /** Only these lifts, matched by stable id, however each is spelled. All lifts when absent. */
  lifts?: readonly string[] | undefined;
}

/**
 * Which stored lift names could be missing a max: those with no max that `updateMaxes` would find
 * (`currentMaxLookup`), and, given `lifts`, one of those by stable id. The API reads sets only for
 * these names, and {@link missingTrainingMaxes} applies the same rule to each set.
 */
export function missingMaxCandidate(
  trainingMaxes: MissingTrainingMaxesInput["trainingMaxes"],
  lifts?: readonly string[],
): (lift: string) => boolean {
  const maxFor = currentMaxLookup(trainingMaxes);
  const wanted = lifts && new Set(lifts.map(liftIdFor));
  return (lift) => !maxFor(lift) && (!wanted || wanted.has(liftIdFor(lift)));
}

/**
 * A training max estimated from `sets`, or null when none is usable.
 *
 * Of the sets dated within {@link MISSING_MAX_ESTIMATE_WEEKS} weeks of the latest one, it takes the
 * set with the highest estimated one-rep max (Brzycki, `estimateOneRepMax`), and the training max
 * is {@link trainingMaxFromOneRepMax} of it, onboarding's calculation. It floors, as a
 * formula-derived estimate does (docs/standards/training-max-precision.md). A set with no weight,
 * no reps or more than {@link MAX_ESTIMATE_REPS} reps is left out. A tie goes to the later set.
 */
export function estimateTrainingMax(sets: readonly EstimateSet[]): TrainingMaxEstimate | null {
  const usable = sets.filter((s) => s.weight > 0 && s.reps > 0 && s.reps <= MAX_ESTIMATE_REPS);
  if (usable.length === 0) return null;
  const time = (s: EstimateSet) => new Date(s.date).getTime();
  const latest = usable.reduce((max, s) => Math.max(max, time(s)), -Infinity);
  const since = latest - MISSING_MAX_ESTIMATE_WEEKS * 7 * DAY_MS;
  let best: { set: EstimateSet; oneRepMax: number } | undefined;
  for (const set of usable) {
    if (time(set) < since) continue;
    const oneRepMax = estimateOneRepMax(set.weight, set.reps);
    if (!best || oneRepMax > best.oneRepMax || (oneRepMax === best.oneRepMax && time(set) > time(best.set))) {
      best = { set, oneRepMax };
    }
  }
  if (!best) return null;
  const weight = trainingMaxFromOneRepMax(best.oneRepMax);
  if (weight <= 0) return null;
  const { date, weight: setWeight, reps } = best.set;
  return { weight, from: { date: new Date(date), weight: setWeight, reps } };
}

/**
 * The lifts in `records` with no training max, one per stable id, latest set first (#1246).
 *
 * A lift is listed when {@link missingMaxCandidate} holds, so it lists the lifts progression
 * reports as `no-training-max`. Only sets that move the lift's own max count (`movesLiftMax`): a
 * set under a `none` or `own` modification, or from a later occurrence in its workout, moves none
 * of it (#1152, #1153, #1027).
 */
export function missingTrainingMaxes({
  trainingMaxes,
  records,
  modificationModes,
  lifts,
}: MissingTrainingMaxesInput): MissingTrainingMax[] {
  const isCandidate = missingMaxCandidate(trainingMaxes, lifts);
  const byId = new Map<string, MissingTrainingMaxesInput["records"][number][]>();
  for (const record of records) {
    if (!isCandidate(record.lift) || !movesLiftMax(record, modificationModes)) continue;
    const id = liftIdFor(record.lift);
    const sets = byId.get(id);
    if (sets) sets.push(record);
    else byId.set(id, [record]);
  }
  const time = (s: { date: Date }) => new Date(s.date).getTime();
  return [...byId.entries()]
    .map(([liftId, sets]) => {
      // The latest set names the lift; a tie goes to the name first in sort order, so two
      // spellings logged on one day give the same name whatever order the sets arrive in.
      const last = sets.reduce((a, b) => (time(b) > time(a) || (time(b) === time(a) && b.lift < a.lift) ? b : a));
      return {
        lift: last.lift,
        liftId,
        setCount: sets.length,
        lastLoggedDate: new Date(last.date),
        estimate: estimateTrainingMax(sets),
      };
    })
    .sort((a, b) => b.lastLoggedDate.getTime() - a.lastLoggedDate.getTime() || a.lift.localeCompare(b.lift));
}
