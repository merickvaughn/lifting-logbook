import { LiftingProgramSpec, LiftRecord, TrainingMax } from "@src/core/models";

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
 */
export function updateMaxes(
  programSpec: LiftingProgramSpec[],
  trainingMaxes: TrainingMax[],
  liftRecords: LiftRecord[],
): UpdateMaxesResult {
  const newMaxes: TrainingMax[] = trainingMaxes.map((tm) => ({ ...tm }));
  const flagged: MaxReductionFlag[] = [];

  // Lookups built once rather than scanned once per record (issue #983).
  // First-wins on a duplicate lift, which is exactly what the per-record
  // `findIndex` / `find` returned; the map holds the same objects that sit in
  // `newMaxes`, so a mutation through it lands in the returned array.
  const maxByLift = new Map<string, TrainingMax>();
  for (const tm of newMaxes) if (!maxByLift.has(tm.lift)) maxByLift.set(tm.lift, tm);
  const specByLift = new Map<string, LiftingProgramSpec>();
  for (const ps of programSpec) if (!specByLift.has(ps.lift)) specByLift.set(ps.lift, ps);

  // A test week's final set needs every set of that lift in the same workout,
  // best attempt first. Grouped once, lazily, on the first such set: each group
  // keeps input order and is sorted by setNum descending once — a stable sort of
  // the input-ordered group is exactly what filtering then sorting the whole
  // list per record produced, without re-walking it for every final set.
  let setsByLiftAndWorkout: Map<string, Map<number, LiftRecord[]>> | null = null;
  const setsFor = (lift: string, workoutNum: number): LiftRecord[] => {
    if (setsByLiftAndWorkout === null) {
      setsByLiftAndWorkout = new Map();
      for (const r of liftRecords) {
        let byWorkout = setsByLiftAndWorkout.get(r.lift);
        if (!byWorkout) {
          byWorkout = new Map();
          setsByLiftAndWorkout.set(r.lift, byWorkout);
        }
        const group = byWorkout.get(r.workoutNum);
        if (group) group.push(r);
        else byWorkout.set(r.workoutNum, [r]);
      }
      for (const byWorkout of setsByLiftAndWorkout.values()) {
        for (const group of byWorkout.values()) group.sort((a, b) => b.setNum - a.setNum);
      }
    }
    return setsByLiftAndWorkout.get(lift)?.get(workoutNum) ?? [];
  };

  liftRecords.forEach((record) => {
    const liftName = record.lift;
    const currentMax = maxByLift.get(liftName);
    if (!currentMax) throw new Error(`Training max for lift ${liftName} not found.`);

    const spec = specByLift.get(liftName);
    if (!spec) throw new Error(`Program spec for lift ${liftName} not found.`);

    const weekType = spec.weekType ?? 'training';

    if (weekType === 'deload') return;

    if (weekType === 'test') {
      // Only process when we see the final set, then walk backwards to find the best
      // unaffected set (in case the final set was flagged as abnormal).
      if (record.setNum !== spec.sets) return;

      // Every set of this lift in the same workout, descending: best attempt first.
      const liftSetRecords = setsFor(liftName, record.workoutNum);

      const candidate = liftSetRecords.find((r) => r.reps > 0 && !isAbnormal(r.notes));
      if (
        candidate &&
        new Date(candidate.date).getTime() > new Date(currentMax.dateUpdated).getTime()
      ) {
        if (candidate.weight < currentMax.weight) {
          flagged.push({ lift: liftName, currentWeight: currentMax.weight, proposedWeight: candidate.weight });
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
        flagged.push({ lift: liftName, currentWeight: currentMax.weight, proposedWeight: updatedWeight });
      } else {
        currentMax.weight = updatedWeight;
        currentMax.dateUpdated = record.date;
      }
    }
  });

  return { maxes: newMaxes, flagged };
}
