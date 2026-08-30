import type { LiftClassification } from '@lifting-logbook/types';
import { LIFT_CATALOG } from './lifts';
import { DEFAULT_SLOT_MAP } from './slotMaps';

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
 * Every name a built-in lift can be referred to by, mapped to its training role.
 *
 * Built eagerly from `Object.entries(DEFAULT_SLOT_MAP)` — same eager-const
 * rationale as `aliasesLowerToCanonical` and `aliasSet` in `slotMaps.ts`, and it
 * turns the lookup below into a single Map hit rather than a linear catalog scan
 * per lift.
 *
 * Building it this way also makes the prototype-pollution hazard *structurally
 * impossible* rather than something a guard has to catch: `Object.entries`
 * yields only own enumerable properties, and a `Map` has no prototype chain to
 * walk, so a lift named "toString" / "constructor" / "__proto__" simply misses.
 * The indexed form this replaces — `DEFAULT_SLOT_MAP[name]` — reads an inherited
 * `Object.prototype` member back as though it were a catalog id, which is the
 * bug `validateLiftImport` needs an explicit `hasOwnProperty` check to avoid.
 */
const BUILT_IN_CLASSIFICATIONS: ReadonlyMap<string, LiftClassification> = new Map(
  Object.entries(DEFAULT_SLOT_MAP).flatMap(([alias, catalogId]) => {
    const lift = LIFT_CATALOG.find((entry) => entry.id === catalogId);
    return lift ? [[alias, lift.classification] as const] : [];
  }),
);

/**
 * The training role of a lift, looked up by the name a workout refers to it by.
 *
 * Built-in lifts resolve with no I/O and no new data: {@link DEFAULT_SLOT_MAP}
 * already maps every program-spec slot name — canonical ("Squat") and
 * CSV-abbreviated ("Bench P.") alike — onto a {@link LIFT_CATALOG} id, and every
 * catalog entry already carries a `classification`. Custom lifts are matched by
 * exact name from the list the caller passes.
 *
 * **A built-in wins a name collision**, matching the precedence
 * `buildEffectiveSlotMap` states for slot resolution: DEFAULT_SLOT_MAP's keys are
 * shared vocabulary every program template relies on, so a custom lift must never
 * shadow a canonical abbreviation. (This is the opposite of `resolveLift`'s
 * custom-first rule, deliberately — that one resolves by *id*, where a collision
 * means the same entity and user intent should win. Here a collision means two
 * different lifts that happen to share a name.)
 *
 * Returns `undefined` for a name in neither list, which callers read as "no
 * opinion" rather than as a classification — the rest timer, for instance, falls
 * through to its preset rather than assuming a lift is an accessory.
 */
export function liftClassificationFor(
  name: string,
  customLifts: readonly ClassifiableLift[] = [],
): LiftClassification | undefined {
  return (
    BUILT_IN_CLASSIFICATIONS.get(name) ??
    customLifts.find((lift) => lift.name === name)?.classification
  );
}
