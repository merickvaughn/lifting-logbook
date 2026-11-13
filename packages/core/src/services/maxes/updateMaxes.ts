import type { LiftModificationMaxMode, ProgressionType, WeekType } from "@lifting-logbook/types";
import { LiftingProgramSpec, LiftOverride, LiftRecord, ModificationMax, TrainingMax } from "@src/core/models";
import { lookupLift, NamedLift } from "../../catalog/builtInLift";
import { currentMaxLookup, liftIdFor, lookupByLift } from "../../catalog/liftIdentity";
import {
  baseSpecMesocycleWeeks,
  mesocycleWeekForProgramWeek,
  programWorkoutKeys,
  specRowsForWorkoutDay,
} from "../../presets/programLengths";
import { resolveDayPrescriptions } from "../workout/dayPrescriptions";
import {
  LiftProgressionMeta,
  ResolvedProgression,
  resolveProgression,
  storedLiftProgression,
  UserProgressionDefault,
} from "./resolveProgression";

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
 * A lift whose records `updateMaxes` left out (#1150): it has no training max; it has no spec
 * row and no progression settings were given to progress it by; or, off-program, its resolved
 * type needs a rep target and none resolved (#1211). Imported history often names lifts the
 * program doesn't plan.
 */
export interface SkippedLift {
  /** The lift as its first skipped record names it. */
  lift: string;
  reason: 'no-training-max' | 'no-program-spec' | 'no-target-reps';
}

export interface UpdateMaxesResult {
  maxes: TrainingMax[];
  flagged: MaxReductionFlag[];
  /** One entry per lift (however its records spell it) and reason, in the order its first record appears. */
  skipped: SkippedLift[];
  /** Every own max given in `modificationMaxes`, moved where a set moved it, plus any it created (#1153). */
  modificationMaxes: ModificationMax[];
}

/** The lifter's progression settings, which resolve each lift's type, rep range and increment (#1211). */
export interface ProgressionSettings {
  /** The lifter's `lift_metadata` rows. A crossed rep range reads as unset (`storedLiftProgression`). */
  liftMeta: readonly ({ lift: string } & LiftProgressionMeta)[];
  /** The lifter's default from Settings; null means the catalog's defaults apply. */
  userDefault: UserProgressionDefault | null;
  /** `user_settings.defaultWeightIncrement`, the off-program increment's last fallback. */
  defaultWeightIncrement: number | null;
  /** The lifter's custom lifts. A name one of them takes means it, and a custom lift has no catalog default (`lookupLift`). */
  customLifts: readonly NamedLift[];
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
  /**
   * The lifter's progression settings (#1211). With them, a lift's type falls through from its
   * spec row to its own value, the lifter's default and the catalog's, and a lift with no spec
   * row progresses by its own target. Without them only a spec row's `progression` applies,
   * every other row follows `amrap_gated`, and a lift with no spec row is skipped.
   */
  progression?: ProgressionSettings;
  /**
   * Set when the macrocycle the records belong to is ending (`startNewMacrocycle`). An off-program
   * `percent_wave` lift has no wave to follow, so its max moves once, then (#1211).
   */
  endOfMacrocycle?: boolean;
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

/** What moves a max for one record: its resolved type and increment, read against its row or its own target. */
interface Rule {
  type: ProgressionType;
  /** The row's; `training` for a lift with no row. */
  weekType: WeekType;
  /** The row's set count; undefined for a lift with no row, where every logged set counts. */
  sets: number | undefined;
  /** The rep target: the row's `reps`, else the resolved `repsHigh`. */
  target: number | null;
  increment: number;
}

/** The types a session's sets move, by reading a rep target. */
const NEEDS_TARGET: ReadonlySet<ProgressionType> = new Set(['linear', 'double', 'amrap_gated']);

/**
 * Updates training maxes based on lift records and program spec.
 *
 * Behavior varies by weekType:
 *  - 'training' (default): the max moves by the record's resolved progression type (#1211):
 *      - `amrap_gated`: set 1 reps >= the target; new TM = weight + increment. Today's rule, and
 *        what a row with no type follows when no progression settings are given.
 *      - `linear` and `double`: every set of the session reaches the target (inside a program, at
 *        least the row's `sets` of them); new TM = set 1's weight + increment. For `double` the
 *        target is the top of the range.
 *      - `percent_wave`: no set moves it. The max moves by the increment once per wave, on the
 *        lift's last set in the spec's last week of each pass through the spec's weeks; a program
 *        that tiles its spec twice has two waves. Off-program, once at `endOfMacrocycle`.
 *      - `manual`: never.
 *  - 'test': uses final set (setNum === spec.sets); any non-zero reps without abnormal notes → new TM = weight (no increment).
 *            Abnormal-notes fallback: walk backwards through sets until an unaffected set is found.
 *            The same for every type.
 *  - 'deload': no progression — returns input maxes unchanged, for every type.
 *
 * The target is the row's `reps` inside a program, and the resolved `repsHigh` off it; the
 * increment is the row's inside a program and the lift's own, then the default's, off it
 * (`resolveProgression`). An off-program lift whose type needs a target and has none is
 * skipped as `no-target-reps`.
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
 * A record whose lift has no training max is skipped and listed in `skipped`, so one unplanned
 * lift doesn't stop the rest from progressing (#1150). So is one with no spec row when no
 * progression settings are given.
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

  // The rule a record follows, or why it has none. Without progression settings a row resolves
  // from its own `progression` alone, and a lift with no row has nothing to follow.
  const settings = options.progression;
  const liftMetaFor = lookupByLift((settings?.liftMeta ?? []).map((m) => [m.lift, storedLiftProgression(m)] as const));
  const catalogFor = (lift: string) => {
    const { builtIn, custom } = lookupLift(lift, settings?.customLifts ?? []);
    return custom ? undefined : builtIn;
  };
  const ruleFor = (record: LiftRecord, spec: LiftingProgramSpec | undefined): Rule | SkippedLift['reason'] => {
    if (!spec && !settings) return 'no-program-spec';
    const resolved: ResolvedProgression = settings
      ? resolveProgression(
          spec,
          liftMetaFor(record.lift),
          settings.userDefault,
          catalogFor(record.lift),
          settings.defaultWeightIncrement,
        )
      : resolveProgression(spec, null, null, null);
    const target = spec ? spec.reps : resolved.repsHigh;
    if (target === null && NEEDS_TARGET.has(resolved.type)) return 'no-target-reps';
    return {
      type: resolved.type,
      weekType: spec?.weekType ?? 'training',
      sets: spec?.sets,
      target,
      increment: resolved.increment,
    };
  };

  // A wave ends with the spec's last week, once per pass through the spec's weeks (#1211). A
  // percent_wave set in that week marks its pass; the latest one in the pass moves the max.
  const specWeeks = baseSpecMesocycleWeeks(programSpec);
  const waveOf = (record: LiftRecord): number | undefined => {
    const day = days[record.workoutNum - 1];
    if (!day || specWeeks === 0 || mesocycleWeekForProgramWeek(day.week, specWeeks) !== specWeeks) return undefined;
    return Math.ceil(day.week / specWeeks);
  };
  // Each max's wave bumps, keyed by pass (or `off` for the macrocycle's end off-program).
  type WaveBumps = Map<number | 'off', { date: Date; increment: number }>;
  const noteWave = (bumps: WaveBumps, record: LiftRecord, spec: LiftingProgramSpec | undefined, rule: Rule) => {
    if (rule.type !== 'percent_wave' || rule.weekType === 'test') return;
    const key = spec ? waveOf(record) : options.endOfMacrocycle ? 'off' : undefined;
    if (key === undefined) return;
    const seen = bumps.get(key);
    if (!seen || new Date(record.date).getTime() > new Date(seen.date).getTime()) {
      bumps.set(key, { date: record.date, increment: rule.increment });
    }
  };
  // The bumps in date order, each applied once when it is newer than the max (so a re-run is a no-op).
  const applyWaves = (bumps: WaveBumps | undefined, max: { weight: number; dateUpdated: Date } | undefined) => {
    if (!bumps || !max) return;
    const ordered = [...bumps.values()].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    for (const { date, increment } of ordered) {
      if (new Date(date).getTime() <= new Date(max.dateUpdated).getTime()) continue;
      max.weight += increment;
      max.dateUpdated = date;
    }
  };

  // A session's sets need every set of that lift in the same workout, best attempt first.
  // Grouped once, lazily, on the first such set: each group keeps input order and is sorted by
  // setNum descending once — a stable sort of the input-ordered group is exactly what filtering
  // then sorting the whole list per record produced, without re-walking it for every final set.
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

  const liftWaves = new Map<TrainingMax, WaveBumps>();
  progressed.forEach((record) => {
    const liftName = record.lift;
    const currentMax = maxFor(liftName);
    if (!currentMax) return skip(liftName, 'no-training-max');

    const spec = specFor(record);
    const rule = ruleFor(record, spec);
    if (typeof rule === 'string') return skip(liftName, rule);

    let bumps = liftWaves.get(currentMax);
    if (!bumps) liftWaves.set(currentMax, (bumps = new Map()));
    noteWave(bumps, record, spec, rule);

    const next = proposedMax(record, rule, currentMax, () => setsFor(currentMax, record.workoutNum));
    if (!next) return;
    if (next.weight < currentMax.weight) {
      flagged.push({ lift: currentMax.lift, currentWeight: currentMax.weight, proposedWeight: next.weight });
    } else {
      currentMax.weight = next.weight;
      currentMax.dateUpdated = next.date;
    }
  });
  for (const [max, bumps] of liftWaves) applyWaves(bumps, max);

  // A set with an `own` modification moves that modification's max under the same gates, and needs
  // no lift max (#1153). With no own max yet, its first qualifying set creates one. It follows its
  // lift's resolved progression.
  const ownMaxes = new Map<string, ModificationMax>(
    options.modificationMaxes.map((m) => [m.modificationId, { ...m }]),
  );
  const ownSets = liftRecords.flatMap((r) => {
    const target = r.occurrence ? undefined : targetOf(r, options.modificationModes);
    return typeof target === 'object' ? [{ record: r, id: target.own }] : [];
  });
  // A session's sets of one own max in one workout, best attempt first. Few sets carry an own
  // modification, so this filters per set rather than grouping up front.
  const ownSetsFor = (id: string, workoutNum: number): LiftRecord[] =>
    ownSets
      .filter((s) => s.id === id && s.record.workoutNum === workoutNum)
      .map((s) => s.record)
      .sort((a, b) => b.setNum - a.setNum);

  const ownWaves = new Map<string, WaveBumps>();
  ownSets.forEach(({ record, id }) => {
    const spec = specFor(record);
    const rule = ruleFor(record, spec);
    if (typeof rule === 'string') return skip(record.lift, rule);

    let bumps = ownWaves.get(id);
    if (!bumps) ownWaves.set(id, (bumps = new Map()));
    noteWave(bumps, record, spec, rule);

    const current = ownMaxes.get(id);
    const next = proposedMax(record, rule, current, () => ownSetsFor(id, record.workoutNum));
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
  // An own max not created yet has nothing for a wave to move.
  for (const [id, bumps] of ownWaves) applyWaves(bumps, ownMaxes.get(id));

  return { maxes: newMaxes, flagged, skipped, modificationMaxes: [...ownMaxes.values()] };
}

/**
 * The max `record` would set under its rule, or undefined when it sets none.
 * `current` is the max it moves: undefined for an own max not created yet, which any qualifying set
 * is newer than. `sessionSets` gives that max's sets in the record's workout, best attempt first.
 */
function proposedMax(
  record: LiftRecord,
  rule: Rule,
  current: { dateUpdated: Date } | undefined,
  sessionSets: () => LiftRecord[],
): { weight: number; date: Date } | undefined {
  const newer = (date: Date) =>
    !current || new Date(date).getTime() > new Date(current.dateUpdated).getTime();

  if (rule.weekType === 'deload') return undefined;

  if (rule.weekType === 'test') {
    // Only process when we see the final set, then walk backwards to find the best
    // unaffected set (in case the final set was flagged as abnormal).
    if (record.setNum !== rule.sets) return undefined;
    const candidate = sessionSets().find((r) => r.reps > 0 && !isAbnormal(r.notes));
    return candidate && newer(candidate.date) ? { weight: candidate.weight, date: candidate.date } : undefined;
  }

  // training week: set 1 decides, for the types a set moves (not manual, percent_wave or rpe)
  if (!NEEDS_TARGET.has(rule.type)) return undefined;
  if (record.setNum !== 1 || rule.target === null || !newer(record.date)) return undefined;
  if (rule.type === 'amrap_gated') {
    if (record.reps < rule.target) return undefined;
  } else {
    // linear and double: every set of the session reaches the target, and none is missing.
    const target = rule.target;
    const sets = sessionSets();
    if (sets.length < (rule.sets ?? 1) || sets.some((s) => s.reps < target)) return undefined;
  }
  const updatedWeight = record.weight + rule.increment;
  if (typeof updatedWeight !== "number" || isNaN(updatedWeight)) {
    throw new Error(`Updated weight for ${record.lift} is not a valid number: ${updatedWeight}`);
  }
  return { weight: updatedWeight, date: record.date };
}
