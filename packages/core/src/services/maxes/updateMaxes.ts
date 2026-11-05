import { LiftingProgramSpec, LiftOverride, LiftRecord, TrainingMax } from "@src/core/models";
import { currentMaxLookup, lookupByLift } from "../../catalog/liftIdentity";
import { programWorkoutKeys, specRowsForWorkoutDay } from "../../presets/programLengths";
import { resolveDayPrescriptions } from "../workout/dayPrescriptions";

const ABNORMAL_KEYWORDS = ['injury', 'unusual stimulus', 'skip'];

function isAbnormal(notes: string): boolean {
  const lower = notes.toLowerCase();
  return ABNORMAL_KEYWORDS.some((kw) => lower.includes(kw));
}

/** A computed TM update that would reduce the current max — requires explicit user review. */
export interface MaxReductionFlag {
  lift: string;
  currentWeight: number;
  proposedWeight: number;
}

export interface UpdateMaxesResult {
  maxes: TrainingMax[];
  flagged: MaxReductionFlag[];
}

export interface UpdateMaxesOptions {
  /** The records' program, which numbers its workouts (`programWorkoutKeys`). */
  program: string;
  /** Each workout's Manage Lifts overrides by `workoutNum`, in the order the repositories return them. */
  liftOverrides: ReadonlyMap<number, readonly LiftOverride[]>;
}

/**
 * Updates training maxes based on lift records and program spec.
 *
 * Behavior varies by weekType:
 *  - 'training' (default): progression gate is set 1 reps >= spec.reps; new TM = weight + increment.
 *  - 'test': uses final set (setNum === spec.sets); any non-zero reps without abnormal notes → new TM = weight (no increment).
 *            Abnormal-notes fallback: walk backwards through sets until an unaffected set is found.
 *  - 'deload': no progression — returns input maxes unchanged.
 *
 * In both training and test weeks, if the computed new TM would be lower than the current TM,
 * the update is NOT applied. Instead the lift is added to `flagged` so the caller can surface
 * the proposed reduction for explicit user review.
 *
 * A record's spec row is its workout day's, resolved the way the workout pages resolve
 * it (issue #1028): the block week its program week tiles from, at the day's offset
 * (`specRowsForWorkoutDay`), and for a Manage Lifts replacement, the row of the slot it
 * took (`resolveDayPrescriptions`), so it progresses its own training max by the slot's rules.
 * Sets logged under a slot's earlier name, before a swap, take the slot's row too, and
 * still progress their own lift's max. A record the day doesn't prescribe (an added
 * lift, or a workout past the program's last day) falls back to the lift's first spec
 * row, as before.
 */
export function updateMaxes(
  programSpec: LiftingProgramSpec[],
  trainingMaxes: TrainingMax[],
  liftRecords: LiftRecord[],
  options: UpdateMaxesOptions,
): UpdateMaxesResult {
  const newMaxes: TrainingMax[] = trainingMaxes.map((tm) => ({ ...tm }));
  const flagged: MaxReductionFlag[] = [];

  // Where a day plans a lift twice, its first occurrence progresses it, under the row
  // `resolveDayPrescriptions` gives the lift. A later occurrence (a superset, or extra
  // volume) has its own prescription and its own set numbers, and would otherwise be
  // read as a second set 1 under the first occurrence's rules (#1027).
  const progressed = liftRecords.filter((r) => !r.occurrence);

  // Lookups built once rather than scanned once per record (issue #983). A record, its
  // max and its spec row can each spell the lift differently (#1118), so they join on
  // `liftIdFor`. The map holds the same objects that sit in `newMaxes`, so a mutation
  // through it lands in the returned array.
  const maxFor = currentMaxLookup(newMaxes);
  const programSpecFor = lookupByLift(programSpec.map((ps) => [ps.lift, ps] as const));

  // Each workout's stored lift name → its spec row, built once per workout.
  const days = programWorkoutKeys(options.program, programSpec);
  const specByWorkout = new Map<number, (name: string) => LiftingProgramSpec | undefined>();
  const specFor = (record: LiftRecord): LiftingProgramSpec | undefined => {
    let dayRowFor = specByWorkout.get(record.workoutNum);
    if (!dayRowFor) {
      const day = days[record.workoutNum - 1];
      const dayRows = day ? specRowsForWorkoutDay(programSpec, day.week, day.offset) : [];
      dayRowFor = lookupByLift(
        resolveDayPrescriptions(
          dayRows,
          options.liftOverrides.get(record.workoutNum) ?? [],
        ).rowByStoredLift,
      );
      specByWorkout.set(record.workoutNum, dayRowFor);
    }
    return dayRowFor(record.lift) ?? programSpecFor(record.lift);
  };

  // A test week's final set needs every set of that lift in the same workout,
  // best attempt first. Grouped once, lazily, on the first such set: each group
  // keeps input order and is sorted by setNum descending once — a stable sort of
  // the input-ordered group is exactly what filtering then sorting the whole
  // list per record produced, without re-walking it for every final set.
  // Keyed by the max a set reads, so sets count as one lift exactly when they share a max.
  let setsByMaxAndWorkout: Map<TrainingMax, Map<number, LiftRecord[]>> | null = null;
  const setsFor = (max: TrainingMax, workoutNum: number): LiftRecord[] => {
    if (setsByMaxAndWorkout === null) {
      setsByMaxAndWorkout = new Map();
      for (const r of progressed) {
        const recordMax = maxFor(r.lift);
        if (!recordMax) continue;
        let byWorkout = setsByMaxAndWorkout.get(recordMax);
        if (!byWorkout) {
          byWorkout = new Map();
          setsByMaxAndWorkout.set(recordMax, byWorkout);
        }
        const group = byWorkout.get(r.workoutNum);
        if (group) group.push(r);
        else byWorkout.set(r.workoutNum, [r]);
      }
      for (const byWorkout of setsByMaxAndWorkout.values()) {
        for (const group of byWorkout.values()) group.sort((a, b) => b.setNum - a.setNum);
      }
    }
    return setsByMaxAndWorkout.get(max)?.get(workoutNum) ?? [];
  };

  progressed.forEach((record) => {
    const liftName = record.lift;
    const currentMax = maxFor(liftName);
    if (!currentMax) throw new Error(`Training max for lift ${liftName} not found.`);

    const spec = specFor(record);
    if (!spec) throw new Error(`Program spec for lift ${liftName} not found.`);

    const weekType = spec.weekType ?? 'training';

    if (weekType === 'deload') return;

    if (weekType === 'test') {
      // Only process when we see the final set, then walk backwards to find the best
      // unaffected set (in case the final set was flagged as abnormal).
      if (record.setNum !== spec.sets) return;

      // Every set of this lift in the same workout, descending: best attempt first.
      const liftSetRecords = setsFor(currentMax, record.workoutNum);

      const candidate = liftSetRecords.find((r) => r.reps > 0 && !isAbnormal(r.notes));
      if (
        candidate &&
        new Date(candidate.date).getTime() > new Date(currentMax.dateUpdated).getTime()
      ) {
        if (candidate.weight < currentMax.weight) {
          flagged.push({ lift: currentMax.lift, currentWeight: currentMax.weight, proposedWeight: candidate.weight });
        } else {
          currentMax.weight = candidate.weight;
          currentMax.dateUpdated = candidate.date;
        }
      }
      return;
    }

    // training week: process set 1 only
    if (record.setNum !== 1) return;

    if (
      record.reps >= spec.reps &&
      new Date(record.date).getTime() > new Date(currentMax.dateUpdated).getTime()
    ) {
      const updatedWeight = record.weight + spec.increment;
      if (typeof updatedWeight !== "number" || isNaN(updatedWeight)) {
        throw new Error(`Updated weight for ${liftName} is not a valid number: ${updatedWeight}`);
      }
      if (updatedWeight < currentMax.weight) {
        flagged.push({ lift: currentMax.lift, currentWeight: currentMax.weight, proposedWeight: updatedWeight });
      } else {
        currentMax.weight = updatedWeight;
        currentMax.dateUpdated = record.date;
      }
    }
  });

  return { maxes: newMaxes, flagged };
}
