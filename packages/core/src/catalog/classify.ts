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
 * Every string a built-in lift can be referred to by, mapped to its training role.
 *
 * **Three vocabularies reach this lookup, not one.** Seeding it from
 * `DEFAULT_SLOT_MAP` alone covers the built-in 5/3/1 and RPT templates, whose
 * spec `lift` values are slot names — but that is only 8 of the catalog's 23
 * display names. A *custom* program's `lift` values come from `ProgramEditor`'s
 * exercise picker, which is built as `LIFT_CATALOG.map((l) => l.name)` and stores
 * the selected name verbatim, so it speaks catalog **names** — and the near
 * misses are one character wide (`Cable Curls` is a slot name, `Cable Curl` is
 * the catalog name). Catalog **ids** are included on the same reasoning that
 * makes `buildEffectiveSlotMap` self-map them: a row pre-resolved through
 * `liftOverrides` circulates as an id.
 *
 * Slot-map aliases are written last so they win a collision — `Map` keeps the
 * final write for a repeated key. In practice both sides derive from the same
 * catalog entry and agree; the ordering is what makes that a guarantee rather
 * than a coincidence.
 *
 * Built eagerly, same rationale as `aliasesLowerToCanonical` and `aliasSet` in
 * `slotMaps.ts`, which turns the lookup below into a single `Map` hit rather
 * than a linear catalog scan per lift.
 *
 * A `Map` also keeps the *lookup* side prototype-safe: `liftClassificationFor`
 * takes a caller-supplied name, and a plain object would answer
 * `obj["toString"]` with an inherited function. `Map.get` has no prototype chain
 * to walk, so no `hasOwnProperty` guard is needed here — unlike
 * `validateLiftImport`, which reads `DEFAULT_SLOT_MAP` by index and does need one.
 */
const BUILT_IN_CLASSIFICATIONS: ReadonlyMap<string, LiftClassification> = new Map([
  ...LIFT_CATALOG.flatMap((lift) => [
    [lift.name, lift.classification] as const,
    [lift.id, lift.classification] as const,
  ]),
  ...Object.entries(DEFAULT_SLOT_MAP).flatMap(([alias, catalogId]) => {
    const lift = LIFT_CATALOG.find((entry) => entry.id === catalogId);
    return lift ? [[alias, lift.classification] as const] : [];
  }),
]);

/**
 * The training role of a lift, looked up by the name a workout refers to it by.
 *
 * Built-in lifts resolve with no I/O and no new data — by catalog display name
 * ("Cable Curl"), by catalog id ("cable-curl"), or by any {@link DEFAULT_SLOT_MAP}
 * slot name, canonical ("Squat") and CSV-abbreviated ("Bench P.") alike. Custom
 * lifts are matched by **exact** name from the list the caller passes: matching is
 * case- and whitespace-sensitive, so "squat" and " Squat " miss deliberately
 * rather than guessing (`canonicalAliasFor` exists for callers that want the
 * case-insensitive question asked of built-in aliases).
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
