import { builtInLiftFor } from './builtInLift';

/**
 * The identity a stored or planned `lift` string refers to: the catalog id for any
 * spelling of a built-in lift ("Bench Press", "Bench P.", "bench-press"), otherwise the
 * string itself (a custom lift, or a name the app has never seen).
 *
 * The `lift` column holds several spellings of one lift (docs/domain-model.md), so code
 * that compares two of them goes through this rather than `===` (#1118).
 *
 * It takes no custom lifts, so a custom lift named after a catalog name or alias
 * ("Face Pull") reads as the built-in here, unlike in `lookupLift`. Prefer the lookups
 * below, which try the exact name first. The full resolver is planned in #1134.
 */
export function liftIdFor(name: string): string {
  return builtInLiftFor(name)?.id ?? name;
}

/** Whether two `lift` strings refer to the same lift, however each is spelled. */
export function isSameLift(a: string, b: string): boolean {
  return liftIdFor(a) === liftIdFor(b);
}

/**
 * A lookup over `[lift, value]` entries: the exact name, then any entry for the same lift.
 * The first entry wins on a duplicate.
 */
export function lookupByLift<T>(
  entries: Iterable<readonly [string, T]>,
): (name: string) => T | undefined {
  const byName = new Map<string, T>();
  const byId = new Map<string, T>();
  for (const [lift, value] of entries) {
    if (!byName.has(lift)) byName.set(lift, value);
    const id = liftIdFor(lift);
    if (!byId.has(id)) byId.set(id, value);
  }
  return (name) => byName.get(name) ?? byId.get(liftIdFor(name));
}

/**
 * A lookup over `[lift, value]` entries that crosses spellings only through the catalog id:
 * the exact name, then the entry stored under the name's id, or for a name that is an id,
 * the first entry under a spelling of it.
 *
 * `Bench Press` finds a `bench-press` entry and the reverse. Two names stay apart, even for
 * one lift, because a program can set them up separately (`C. Lat Raise`, `Lateral Raise`),
 * so use this over {@link lookupByLift} for anything a user can set per slot (#1135).
 */
export function lookupByStoredId<T>(
  entries: Iterable<readonly [string, T]>,
): (name: string) => T | undefined {
  const byName = new Map<string, T>();
  const byNamedId = new Map<string, T>();
  for (const [lift, value] of entries) {
    if (!byName.has(lift)) byName.set(lift, value);
    const id = liftIdFor(lift);
    if (lift !== id && !byNamedId.has(id)) byNamedId.set(id, value);
  }
  return (name) => byName.get(name) ?? byName.get(liftIdFor(name)) ?? byNamedId.get(name);
}

/**
 * What to list each of `names` as, where one row per lift is wanted: a name stored as a
 * catalog id joins a spelling of that lift (the first in sort order) when `names` has one,
 * and every other name stays itself. The same rule as {@link lookupByStoredId}: `bench-press`
 * lists as `Bench Press`, while `C. Lat Raise` and `Lateral Raise` stay two rows (#1135).
 */
export function storedIdListing(names: Iterable<string>): (name: string) => string {
  const namedById = new Map<string, string>();
  for (const name of [...new Set(names)].sort()) {
    const id = liftIdFor(name);
    if (name !== id && !namedById.has(id)) namedById.set(id, name);
  }
  return (name) => namedById.get(name) ?? name;
}

/**
 * A lookup for a lift's current training max, by any spelling.
 *
 * Import stores a row by catalog id with no record of which slot it came from, so a
 * row under the exact name competes with an id row, and the more recent one is current.
 * That lets a new import take effect over `Bench Press`. A row under another name
 * applies only when neither exists, since one program can plan two names as separate
 * slots with separate maxes (`C. Lat Raise` and `Lateral Raise`).
 *
 * Dates compare by day, the precision the API returns, so the server and the web agree.
 * A tie goes to the exact name, otherwise to the earlier name in sort order, which keeps
 * the answer independent of row order.
 */
export function currentMaxLookup<T extends { lift: string; dateUpdated: Date | string }>(
  maxes: readonly T[],
): (name: string) => T | undefined {
  const byName = new Map<string, T>();
  const byId = new Map<string, T>();
  for (const max of maxes) {
    const named = byName.get(max.lift);
    if (!named || dayOf(max) > dayOf(named)) byName.set(max.lift, max);
    const id = liftIdFor(max.lift);
    const held = byId.get(id);
    if (!held || dayOf(max) > dayOf(held) || (dayOf(max) === dayOf(held) && max.lift < held.lift)) {
      byId.set(id, max);
    }
  }
  return (name) => {
    const id = liftIdFor(name);
    const exact = byName.get(name);
    const stored = byName.get(id);
    if (exact && stored) return dayOf(stored) > dayOf(exact) ? stored : exact;
    return exact ?? stored ?? byId.get(id);
  };
}

function dayOf(max: { dateUpdated: Date | string }): number {
  return Math.floor(new Date(max.dateUpdated).getTime() / 86_400_000);
}
