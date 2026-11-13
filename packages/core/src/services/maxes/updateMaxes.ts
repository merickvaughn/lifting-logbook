import type { LiftModificationMaxMode } from "@lifting-logbook/types";
import { LiftingProgramSpec, LiftOverride, LiftRecord, ModificationMax, TrainingMax } from "@src/core/models";
import { currentMaxLookup, liftIdFor, lookupByLift } from "../../catalog/liftIdentity";
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
  /** Set when the max is a modification's own (#1153); `lift` is then the set's lift. */
  modificationId?: string;
}

/**
 * A lift whose records `updateMaxes` left out: it has no training max, or no spec row to
 * progress it by. Imported history often names lifts the program doesn't plan (#1150).
 */
export interface SkippedLift {
  /** The lift as its first skipped record names it. */
  lift: string;
  reason: 'no-training-max' | 'no-program-spec';
}

export interface UpdateMaxesResult {
  maxes: TrainingMax[];
  flagged: MaxReductionFlag[];
  /** One entry per lift (however its records spell it) and reason, in the order its first record appears. */
  skipped: SkippedLift[];
  /** Every own max given in `modificationMaxes`, moved where a set moved it, plus any it created (#1153). */
  modificationMaxes: ModificationMax[];
}

export interface UpdateMaxesOptions {
  /** The records' program, which numbers its workouts (`programWorkoutKeys`). */
  program: string;
  /** Each workout's Manage Lifts overrides by `workoutNum`, in the order the repositories return them. */
  liftOverrides: ReadonlyMap<number, readonly LiftOverride[]>;
  /**
   * The `maxMode` of each modification the records name, by id (#1152). An id it doesn't have
   * reads as `none`, the default, so a set whose modifications are unknown moves no max.
   * Required, so a caller can't leave it out and read every modified set as `none` (#1243).
   */
  modificationModes: ReadonlyMap<string, LiftModificationMaxMode>;
  /**
   * The program's own maxes, which sets with an `own` modification move (#1153). Required, so a
   * caller can't leave it out and have an `own` set start that max over, unflagged (#1243).
   */
  modificationMaxes: readonly ModificationMax[];
}

/**
 * Which max a set moves (#1153): none if any of its modifications is `none`; otherwise an `own`
 * one's max; otherwise, with no modifications or only `lift` ones, the lift's. A set carries at most
 * one `own`, which the API enforces on write.
 */
function targetOf(
  record: LiftRecord,
  modes: ReadonlyMap<string, LiftModificationMaxMode>,
): 'none' | 'lift' | { own: string } {
  const ids = record.modifications ?? [];
  const modeOf = (id: string) => modes.get(id) ?? 'none';
  if (ids.some((id) => modeOf(id) === 'none')) return 'none';
  const own = ids.find((id) => modeOf(id) === 'own');
  return own === undefined ? 'lift' : { own };
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
 *
 * A record whose lift has no training max, or no spec row at all, is skipped and listed in
 * `skipped`, so one unplanned lift doesn't stop the rest from progressing (#1150).
 */
export function updateMaxes(
  programSpec: LiftingProgramSpec[],
  trainingMaxes: TrainingMax[],
  liftRecords: LiftRecord[],
  options: UpdateMaxesOptions,
): UpdateMaxesResult {
  const newMaxes: TrainingMax[] = trainingMaxes.map((tm) => ({ ...tm }));
  const flagged: MaxReductionFlag[] = [];
  const skipped: SkippedLift[] = [];
  const skippedKeys = new Set<string>();
  const skip = (lift: string, reason: SkippedLift['reason']) => {
    const key = `${reason}:${liftIdFor(lift)}`;
    if (skippedKeys.has(key)) return;
    skippedKeys.add(key);
    skipped.push({ lift, reason });
  };

  // Where a day plans a lift twice, its first occurrence progresses it, under the row
  // `resolveDayPrescriptions` gives the lift. A later occurrence (a superset, or extra
  // volume) has its own prescription and its own set numbers, and would otherwise be
  // read as a second set 1 under the first occurrence's rules (#1027).
  // A set whose modifications send it elsewhere is left out here, so it neither moves the lift's
  // max nor counts as a test week's attempt at it (#1152). Its own max is moved below.
  const progressed = liftRecords.filter((r) => !r.occurrence && targetOf(r, options.modificationModes) === 'lift');

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
    if (!currentMax) return skip(liftName, 'no-training-max');

    const spec = specFor(record);
    if (!spec) return skip(liftName, 'no-program-spec');

    const next = proposedMax(record, spec, currentMax, () => setsFor(currentMax, record.workoutNum));
    if (!next) return;
    if (next.weight < currentMax.weight) {
      flagged.push({ lift: currentMax.lift, currentWeight: currentMax.weight, proposedWeight: next.weight });
    } else {
      currentMax.weight = next.weight;
      currentMax.dateUpdated = next.date;
    }
  });

  // A set with an `own` modification moves that modification's max under the same gates, and needs
  // no lift max (#1153). With no own max yet, its first qualifying set creates one.
  const ownMaxes = new Map<string, ModificationMax>(
    options.modificationMaxes.map((m) => [m.modificationId, { ...m }]),
  );
  const ownSets = liftRecords.flatMap((r) => {
    const target = r.occurrence ? undefined : targetOf(r, options.modificationModes);
    return typeof target === 'object' ? [{ record: r, id: target.own }] : [];
  });
  // A test week's sets of one own max in one workout, best attempt first. Few sets carry an own
  // modification, so this filters per final set rather than grouping up front.
  const ownSetsFor = (id: string, workoutNum: number): LiftRecord[] =>
    ownSets
      .filter((s) => s.id === id && s.record.workoutNum === workoutNum)
      .map((s) => s.record)
      .sort((a, b) => b.setNum - a.setNum);

  ownSets.forEach(({ record, id }) => {
    const spec = specFor(record);
    if (!spec) return skip(record.lift, 'no-program-spec');

    const current = ownMaxes.get(id);
    const next = proposedMax(record, spec, current, () => ownSetsFor(id, record.workoutNum));
    if (!next) return;
    if (!current) {
      ownMaxes.set(id, { modificationId: id, weight: next.weight, dateUpdated: next.date });
    } else if (next.weight < current.weight) {
      flagged.push({ lift: record.lift, currentWeight: current.weight, proposedWeight: next.weight, modificationId: id });
    } else {
      current.weight = next.weight;
      current.dateUpdated = next.date;
    }
  });

  return { maxes: newMaxes, flagged, skipped, modificationMaxes: [...ownMaxes.values()] };
}

/**
 * The max `record` would set, under its spec row's week type, or undefined when it sets none.
 * `current` is the max it moves: undefined for an own max not created yet, which any qualifying set
 * is newer than. `weekSets` gives a test week's sets of that max in the workout, best attempt first.
 */
function proposedMax(
  record: LiftRecord,
  spec: LiftingProgramSpec,
  current: { dateUpdated: Date } | undefined,
  weekSets: () => LiftRecord[],
): { weight: number; date: Date } | undefined {
  const newer = (date: Date) =>
    !current || new Date(date).getTime() > new Date(current.dateUpdated).getTime();
  const weekType = spec.weekType ?? 'training';

  if (weekType === 'deload') return undefined;

  if (weekType === 'test') {
    // Only process when we see the final set, then walk backwards to find the best
    // unaffected set (in case the final set was flagged as abnormal).
    if (record.setNum !== spec.sets) return undefined;
    const candidate = weekSets().find((r) => r.reps > 0 && !isAbnormal(r.notes));
    return candidate && newer(candidate.date) ? { weight: candidate.weight, date: candidate.date } : undefined;
  }

  // training week: process set 1 only
  if (record.setNum !== 1) return undefined;
  if (record.reps < spec.reps || !newer(record.date)) return undefined;
  const updatedWeight = record.weight + spec.increment;
  if (typeof updatedWeight !== "number" || isNaN(updatedWeight)) {
    throw new Error(`Updated weight for ${record.lift} is not a valid number: ${updatedWeight}`);
  }
  return { weight: updatedWeight, date: record.date };
}
