import type { LiftClassification } from '@lifting-logbook/types';
import { builtInLiftFor } from './builtInLift';

/**
 * The slice of a lift {@link liftClassificationFor} needs to classify by name.
 *
 * Declared structurally rather than importing `CustomLiftResponse` so this
 * package keeps no dependency on an API response shape — both
 * `CustomLiftResponse` and the `CustomLift` domain object satisfy it, and a
 * caller passes whichever it already holds.
 */
export interface ClassifiableLift {
  name: string;
  classification: LiftClassification;
}

/**
 * The training role of a lift, looked up by the name a workout refers to it by.
 *
 * Built-in lifts resolve with no I/O through {@link builtInLiftFor} — by catalog display
 * name ("Cable Curl"), catalog id ("cable-curl"), per-entry alias ("Calf Raises") or any
 * `DEFAULT_SLOT_MAP` slot name, canonical ("Squat") and CSV-abbreviated ("Bench P.")
 * alike. Custom lifts are matched by **exact** name from the list the caller passes:
 * matching is case- and whitespace-sensitive, so "squat" and " Squat " miss deliberately
 * rather than guessing (`canonicalAliasFor` exists for callers that want the
 * case-insensitive question asked of built-in aliases).
 *
 * **A built-in wins a name collision**, matching the precedence
 * `buildEffectiveSlotMap` states for slot resolution: DEFAULT_SLOT_MAP's keys are shared
 * vocabulary every program template relies on, so a custom lift must never shadow a
 * canonical abbreviation. (This is the opposite of `resolveLift`'s custom-first rule,
 * deliberately — that one resolves by *id*, where a collision means the same entity and
 * user intent should win. Here a collision means two different lifts that happen to share
 * a name.)
 *
 * Returns `undefined` for a name in neither list, which callers read as "no opinion"
 * rather than as a classification — the rest timer, for instance, falls through to its
 * preset rather than assuming a lift is an accessory.
 */
export function liftClassificationFor(
  name: string,
  customLifts: readonly ClassifiableLift[] = [],
): LiftClassification | undefined {
  return (
    builtInLiftFor(name)?.classification ??
    customLifts.find((lift) => lift.name === name)?.classification
  );
}
