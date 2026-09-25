import { LIFT_CATALOG, type CatalogLift } from './lifts';
import { DEFAULT_SLOT_MAP, isCanonicalAlias } from './slotMaps';

/**
 * Every string a built-in lift can be referred to by, mapped to its catalog entry.
 *
 * **Four forms reach this lookup, not one.** The built-in 5/3/1 template's spec `lift`
 * values are `DEFAULT_SLOT_MAP` slot names ("Squat"), which cover only a few catalog
 * display names; the Leangains and RPT presets mix slot names, catalog display names
 * ("Romanian Deadlift") and names of their own. A *custom* program's `lift` values come
 * from `ProgramEditor`'s exercise picker, which is built as
 * `LIFT_CATALOG.map((l) => l.name)` and stores the selected name verbatim, so it speaks
 * catalog **names** — and the near misses are one character wide (`Cable Curls` is a slot
 * name, `Cable Curl` is the catalog name). Catalog **ids** are included on the same
 * reasoning that makes `buildEffectiveSlotMap` self-map them: a row pre-resolved through
 * `liftOverrides` circulates as an id. Per-entry **aliases** cover the preset names that
 * are neither ("Weighted Pull-ups", "Calf Raises") — see `CatalogLift.aliases` for why
 * those stay out of `DEFAULT_SLOT_MAP`.
 *
 * Slot-map aliases are written last so they win a collision — `Map` keeps the final
 * write for a repeated key. In practice every side derives from the same catalog entry
 * and agrees; the ordering is what makes that a guarantee rather than a coincidence.
 *
 * Built eagerly, same rationale as `aliasesLowerToCanonical` and `aliasSet` in
 * `slotMaps.ts`: a single `Map` hit per lookup rather than a catalog scan per lift.
 *
 * A `Map` also keeps the lookup prototype-safe: callers pass arbitrary names, and a plain
 * object would answer `obj["toString"]` with an inherited function. `Map.get` has no
 * prototype chain to walk, so no `hasOwnProperty` guard is needed here — unlike
 * `validateLiftImport`, which reads `DEFAULT_SLOT_MAP` by index and does need one.
 */
const BUILT_IN_LIFTS: ReadonlyMap<string, CatalogLift> = (() => {
  const byId = new Map(LIFT_CATALOG.map((lift) => [lift.id, lift] as const));
  return new Map<string, CatalogLift>([
    ...LIFT_CATALOG.flatMap((lift) => [
      [lift.name, lift] as const,
      [lift.id, lift] as const,
      ...(lift.aliases ?? []).map((alias) => [alias, lift] as const),
    ]),
    ...Object.entries(DEFAULT_SLOT_MAP).flatMap(([alias, catalogId]) => {
      const lift = byId.get(catalogId);
      return lift ? [[alias, lift] as const] : [];
    }),
  ]);
})();

/**
 * The built-in catalog lift a workout's lift name refers to — by catalog display name
 * ("Cable Curl"), catalog id ("cable-curl"), per-entry alias ("Calf Raises") or any
 * {@link DEFAULT_SLOT_MAP} slot name ("Squat", "Bench P."). Matching is exact: case- and
 * whitespace-sensitive, so "squat" and " Squat " miss rather than guess.
 *
 * Returns `undefined` for a name that is not a built-in, which callers read as "no
 * opinion" — a custom lift, or a name the app has never seen. Callers that also hold the
 * user's custom lifts should go through {@link lookupLift}, which applies the precedence
 * rule between the two.
 */
export function builtInLiftFor(name: string): CatalogLift | undefined {
  return BUILT_IN_LIFTS.get(name);
}

/** The slice of a custom lift {@link lookupLift} matches on. */
export interface NamedLift {
  name: string;
  /**
   * A custom lift's uuid. Import can store it in a record's `lift` column (a row
   * pre-resolved to a lift created mid-import), so a lookup by name alone would miss it.
   */
  id?: string;
}

/**
 * The built-in and custom lift a workout's lift name refers to, under the one precedence
 * rule that classification and movement patterns share:
 *
 *   - A **reserved** name — a `DEFAULT_SLOT_MAP` slot name, or a catalog id one maps to
 *     (`isCanonicalAlias`) — always means the built-in; `custom` comes back `undefined`.
 *     Those are shared vocabulary every program template relies on, and the custom-lift
 *     create/rename guard already refuses them, so a same-named custom lift can only be
 *     legacy data.
 *   - **Any other name** — a catalog display name ("Face Pull"), a per-entry alias
 *     ("Calf Raises"), a newer catalog name ("Cable Row") — prefers a custom lift with
 *     that exact name or id. The guard allows those names, users created them (the import
 *     wizard does, from raw CSV text), and the attributes they recorded are theirs.
 *
 * Callers read attributes as `custom?.x ?? builtIn?.x`.
 */
export function lookupLift<T extends NamedLift>(
  name: string,
  customLifts: readonly T[],
): { builtIn: CatalogLift | undefined; custom: T | undefined } {
  const builtIn = builtInLiftFor(name);
  if (builtIn && isCanonicalAlias(name)) return { builtIn, custom: undefined };
  const custom = customLifts.find((lift) => lift.name === name || lift.id === name);
  return { builtIn, custom };
}
