import { builtInLiftFor } from './builtInLift';

/**
 * Accepted spellings that stay separate lifts when comparing, though the slot map sends
 * them to a catalog entry. `OH Press-HV` is its own slot in the RPT spec with its own
 * training max, about two thirds of `OH Press`, so reading one as the other would
 * prescribe the wrong weight.
 */
const SEPARATE_SLOTS: ReadonlySet<string> = new Set(['OH Press-HV']);

/**
 * The identity a stored or planned `lift` string refers to: the catalog id for any
 * spelling of a built-in lift ("Bench Press", "Bench P.", "bench-press"), otherwise the
 * string itself (a custom lift, or a name the app has never seen).
 *
 * The `lift` column holds several spellings of one lift (docs/domain-model.md), so code
 * that compares two of them goes through this rather than `===` (#1118).
 */
export function liftIdFor(name: string): string {
  if (SEPARATE_SLOTS.has(name)) return name;
  return builtInLiftFor(name)?.id ?? name;
}

/** Whether two `lift` strings refer to the same lift, however each is spelled. */
export function isSameLift(a: string, b: string): boolean {
  return liftIdFor(a) === liftIdFor(b);
}

/**
 * Each lift's current training max, keyed by {@link liftIdFor}. One lift can hold two
 * rows, such as `Bench Press` from the program and `bench-press` from an import. The most
 * recently updated one is current, so a newly imported max takes effect. On a tie or a
 * missing date the first row wins.
 */
export function currentMaxesByLiftId<T extends { lift: string; dateUpdated?: Date | string }>(
  maxes: readonly T[],
): Map<string, T> {
  const current = new Map<string, T>();
  for (const max of maxes) {
    const id = liftIdFor(max.lift);
    const held = current.get(id);
    if (!held || updatedAt(max) > updatedAt(held)) current.set(id, max);
  }
  return current;
}

function updatedAt(max: { dateUpdated?: Date | string }): number {
  return max.dateUpdated === undefined ? Number.NEGATIVE_INFINITY : new Date(max.dateUpdated).getTime();
}
