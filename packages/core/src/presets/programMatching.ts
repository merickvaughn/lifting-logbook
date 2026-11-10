import { WeekNumber } from '@lifting-logbook/types';
import { builtInLiftFor } from '../catalog/builtInLift';
import { programLengthWeeks, programWorkoutKeys } from './programLengths';

/**
 * A program the importer can match lift history against: its lifts, and how long one
 * run of it is. Built from a program spec by {@link knownProgramFromSpec}.
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
}

/**
 * One identity for every spelling of a lift: a built-in lift's catalog id, or the trimmed
 * name for a custom or unknown lift. "Bench Press" and "bench-press" share a key.
 */
export function liftKey(name: string): string {
  const trimmed = name.trim();
  return builtInLiftFor(trimmed)?.id ?? trimmed;
}

/** The {@link KnownProgram} a spec describes. */
export function knownProgramFromSpec(
  id: string,
  spec: ReadonlyArray<{ week: WeekNumber; offset: number; lift: string }>,
  name?: string,
): KnownProgram {
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    lifts: new Set(spec.map((row) => liftKey(row.lift))),
    workoutCount: programWorkoutKeys(id, spec).length,
    lengthWeeks: programLengthWeeks(id, spec),
  };
}

function programNameKey(value: string): string {
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
  /** Other programs exactly as small that also contain every lift. */
  tiedWith: string[];
}

/**
 * The smallest known program containing every lift (decision 9 of the import macrocycle
 * proposal), or `null` when none does or there are no lifts. A tie goes to
 * `sourceProgram` when it's one of the tied programs, and otherwise to the first of them
 * in `programs` order; `tiedWith` names the rest so the lifter can switch.
 */
export function matchProgramForLifts(
  lifts: Iterable<string>,
  programs: readonly KnownProgram[],
  sourceProgram?: string,
): ProgramMatch | null {
  const keys = new Set([...lifts].map(liftKey));
  if (keys.size === 0) return null;
  const candidates = programsContaining(keys, programs);
  if (candidates.length === 0) return null;
  const smallest = Math.min(...candidates.map((p) => p.lifts.size));
  const tied = candidates.filter((p) => p.lifts.size === smallest);
  const program = tied.find((p) => p.id === sourceProgram) ?? tied[0];
  if (!program) return null;
  return { program, tiedWith: tied.filter((p) => p !== program).map((p) => p.id) };
}
