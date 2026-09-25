import type { LiftClassification } from '@lifting-logbook/types';
import { lookupLift, type NamedLift } from './builtInLift';

/**
 * The slice of a lift {@link liftClassificationFor} needs to classify by name.
 *
 * Declared structurally rather than importing `CustomLiftResponse` so this
 * package keeps no dependency on an API response shape — both
 * `CustomLiftResponse` and the `CustomLift` domain object satisfy it, and a
 * caller passes whichever it already holds.
 */
export interface ClassifiableLift extends NamedLift {
  classification: LiftClassification;
}

/**
 * The training role of a lift, looked up by the name a workout refers to it by.
 *
 * Built-in lifts resolve with no I/O through `builtInLiftFor` — by catalog display name
 * ("Cable Curl"), catalog id ("cable-curl"), per-entry alias ("Calf Raises") or any
 * `DEFAULT_SLOT_MAP` slot name, canonical ("Squat") and CSV-abbreviated ("Bench P.")
 * alike. Custom lifts are matched by **exact** name or id from the list the caller
 * passes: matching is case- and whitespace-sensitive, so "squat" and " Squat " miss
 * deliberately rather than guessing (`canonicalAliasFor` exists for callers that want the
 * case-insensitive question asked of built-in aliases).
 *
 * **A name collision goes to the built-in only for a reserved name** — a
 * `DEFAULT_SLOT_MAP` slot name, which every program template relies on and the
 * custom-lift guard refuses. For any other name ("Face Pull", "Cable Row", "Calf Raises")
 * a same-named custom lift wins: the user recorded that classification. See `lookupLift`.
 * (By *id*, `resolveLift` lets the custom lift win outright — there a collision means the
 * same entity.)
 *
 * Returns `undefined` for a name in neither list, which callers read as "no opinion"
 * rather than as a classification — the rest timer, for instance, falls through to its
 * preset rather than assuming a lift is an accessory.
 */
export function liftClassificationFor(
  name: string,
  customLifts: readonly ClassifiableLift[] = [],
): LiftClassification | undefined {
  const { builtIn, custom } = lookupLift(name, customLifts);
  return custom?.classification ?? builtIn?.classification;
}
