import { WeekNumber } from '@lifting-logbook/types';
import { builtInLiftFor } from '../catalog/builtInLift';
import { programLengthWeeks, programWorkoutKeys } from './programLengths';

/**
 * How a lift's working sets move within one session: `descending` from a top set (a
 * reverse pyramid), `ascending` to a top set (5/3/1's waves), or `straight` (one weight).
 */
export type SetOrder = 'ascending' | 'descending' | 'straight';

/**
 * A program the importer can match lift history against: its lifts, how long one run of
 * it is, and the order each lift's sets follow. Built from a program spec by
 * {@link knownProgramFromSpec}.
 */
export interface KnownProgram {
  id: string;
  /** Display name. A file's `Program` column matches it as well as the id. */
  name?: string;
  /** The program's lifts, as {@link liftKey}s. */
  lifts: ReadonlySet<string>;
  /** Workouts in one run (`programWorkoutKeys`); 0 when the spec has none. */
  workoutCount: number;
  /** Weeks in one run (`programLengthWeeks`). */
  lengthWeeks: number;
  /** The set order each lift follows, by {@link liftKey}, as the program's author wrote it. */
  setOrder: ReadonlyMap<string, SetOrder>;
}

/**
 * One identity for every spelling of a lift: a built-in lift's catalog id, or the trimmed
 * name for a custom or unknown lift. "Bench Press" and "bench-press" share a key.
 */
export function liftKey(name: string): string {
  const trimmed = name.trim();
  return builtInLiftFor(trimmed)?.id ?? trimmed;
}

/**
 * The {@link KnownProgram} a spec describes. Each lift's set order comes from its
 * `wtDecrementPct` (above 0 is a reverse pyramid, else straight sets) unless
 * `compoundSetOrder` overrides it for every lift that pyramids, which the built-in 5/3/1
 * needs: its rows prescribe descending weights, but Wendler's sets climb (#1086).
 */
export function knownProgramFromSpec(
  id: string,
  spec: ReadonlyArray<{ week: WeekNumber; offset: number; lift: string; wtDecrementPct?: number }>,
  compoundSetOrder?: SetOrder,
): KnownProgram {
  const setOrder = new Map<string, SetOrder>();
  for (const row of spec) {
    const pyramids = (row.wtDecrementPct ?? 0) > 0;
    const order: SetOrder = pyramids ? (compoundSetOrder ?? 'descending') : 'straight';
    if (!setOrder.has(liftKey(row.lift))) setOrder.set(liftKey(row.lift), order);
  }
  return {
    id,
    lifts: new Set(setOrder.keys()),
    workoutCount: programWorkoutKeys(id, spec).length,
    lengthWeeks: programLengthWeeks(id, spec),
    setOrder,
  };
}

/** A program name or `Program` cell reduced to lowercase letters and digits: "5/3/1" and "5-3-1" are both "531". */
export function programNameKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The known program a file's `Program` cell names, by id or name, ignoring case and
 * punctuation ("5/3/1" names `5-3-1`), or `undefined` when it names none.
 */
export function programNamedBy(
  value: string,
  programs: readonly KnownProgram[],
): KnownProgram | undefined {
  const key = programNameKey(value);
  if (!key) return undefined;
  return programs.find(
    (p) => programNameKey(p.id) === key || (p.name !== undefined && programNameKey(p.name) === key),
  );
}

/** Every program containing all of `liftKeys`, in the order given. */
export function programsContaining(
  liftKeys: ReadonlySet<string>,
  programs: readonly KnownProgram[],
): KnownProgram[] {
  return programs.filter((p) => [...liftKeys].every((lift) => p.lifts.has(lift)));
}

export interface ProgramMatch {
  program: KnownProgram;
  /** Other programs that were equally good matches. */
  tiedWith: string[];
  /** True when sessions' set order chose between programs that all contain the lifts. */
  bySetOrder: boolean;
}

/**
 * The known program a set of lifts belongs to (decision 9 of the import macrocycle
 * proposal), or `null` when none contains them all or there are no lifts.
 *
 * Among the programs containing every lift, those whose set order agrees with the most
 * sessions win (`setOrderAgreement`, by program id, when the caller has set-order
 * evidence); then the smallest. A remaining tie goes to `sourceProgram` when it's one of
 * them, and otherwise to the first in `programs` order, with `tiedWith` naming the rest.
 */
export function matchProgramForLifts(
  lifts: Iterable<string>,
  programs: readonly KnownProgram[],
  sourceProgram?: string,
  setOrderAgreement?: ReadonlyMap<string, number>,
): ProgramMatch | null {
  const keys = new Set([...lifts].map(liftKey));
  if (keys.size === 0) return null;
  let candidates = programsContaining(keys, programs);
  if (candidates.length === 0) return null;
  const agreement = (p: KnownProgram) => setOrderAgreement?.get(p.id) ?? 0;
  const bestAgreement = Math.max(...candidates.map(agreement));
  const bySetOrder = bestAgreement > 0 && candidates.some((p) => agreement(p) < bestAgreement);
  if (bestAgreement > 0) candidates = candidates.filter((p) => agreement(p) === bestAgreement);
  const smallest = Math.min(...candidates.map((p) => p.lifts.size));
  const tied = candidates.filter((p) => p.lifts.size === smallest);
  const program = tied.find((p) => p.id === sourceProgram) ?? tied[0];
  if (!program) return null;
  return { program, tiedWith: tied.filter((p) => p !== program).map((p) => p.id), bySetOrder };
}
