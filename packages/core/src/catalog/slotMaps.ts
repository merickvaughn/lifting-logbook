import { CustomLift } from '@lifting-logbook/types';

/**
 * Pre-built exercise slot maps for the built-in program templates.
 *
 * A slot map translates the `lift` field from LiftingProgramSpec (which may be
 * an abbreviated or program-specific name) to a canonical catalog Lift id.
 * Existing call sites require no changes — pass DEFAULT_SLOT_MAP to resolveLift.
 */

/**
 * Covers all slot names used by the 5/3/1 and RPT program templates,
 * including both canonical names (from LIFT_NAMES) and CSV-abbreviated forms.
 */
export const DEFAULT_SLOT_MAP: Readonly<Record<string, string>> = {
  // Canonical names shared by 5/3/1 and LIFT_NAMES
  'Squat':           'back-squat',
  'Bench Press':     'bench-press',
  'Deadlift':        'deadlift',
  'Overhead Press':  'overhead-press',
  'Barbell Row':     'barbell-row',
  'Chin-up':         'chin-up',
  'Cable Curls':     'cable-curl',
  'Calf Raise':      'calf-raise',
  'Dips':            'dip',
  'Face Pulls':      'face-pull',
  'Cable Lat Raise': 'lateral-raise',
  'Upright Row':     'upright-row',

  // RPT CSV-abbreviated slot names (where they differ from canonical)
  'Bench P.':    'bench-press',
  'BB Row':      'barbell-row',
  'Dip':         'dip',
  'OH Press':    'overhead-press',
  'OH Press-HV': 'overhead-press',
  'CBL Curls':   'cable-curl',
  'C. Lat Raise': 'lateral-raise',
  'Lat Raise':    'lateral-raise',

  // Canonical IDs map to themselves so that rows pre-resolved by liftOverrides pass
  // strict validation without requiring a separate display-name alias.
  'back-squat':     'back-squat',
  'bench-press':    'bench-press',
  'deadlift':       'deadlift',
  'overhead-press': 'overhead-press',
  'barbell-row':    'barbell-row',
  'chin-up':        'chin-up',
  'cable-curl':     'cable-curl',
  'calf-raise':     'calf-raise',
  'dip':            'dip',
  'face-pull':      'face-pull',
  'lateral-raise':  'lateral-raise',
  'upright-row':    'upright-row',
};

/**
 * Every string DEFAULT_SLOT_MAP resolves — its keys (the human-readable
 * abbreviations/display names it accepts, e.g. "Squat", "Bench P.") AND its
 * values (the canonical ids, e.g. "back-squat"). Used by the REVIEW step's
 * lift-catalog autocomplete datalist and its "is this lift already
 * recognized" check. Checking only the canonical-id values (an earlier
 * version of this file exported that subset alone as `CANONICAL_LIFT_IDS`,
 * since removed as unused once this superseded it) meant a perfectly valid
 * alias like "Squat" read as unrecognized, offering to create a duplicate
 * lift that DEFAULT_SLOT_MAP's own collision precedence then permanently
 * shadowed (issue #911 review).
 */
// readonly + Object.freeze, not a plain mutable string[]: canonicalAliasFor
// below caches a lowercased index derived from this array under the stated
// invariant that it "never goes stale" — a type that permits mutation (this
// is exported through the package barrel, so any consumer could push/sort it)
// would make that comment a claim the compiler doesn't back, the same
// overclaiming-comment pattern this PR's review has already had to correct
// more than once (#911 review, fourth pass).
export const ALL_SLOT_MAP_ALIASES: readonly string[] = Object.freeze([
  ...new Set([...Object.keys(DEFAULT_SLOT_MAP), ...Object.values(DEFAULT_SLOT_MAP)]),
]);

/**
 * Builds a per-request slot map that recognizes a user's custom lifts alongside
 * the built-in DEFAULT_SLOT_MAP (issue #911). Each custom lift is keyed by both
 * its display name (so an import row whose raw text matches it resolves without
 * requiring a manual remap) and its own id (self-mapping, mirroring
 * DEFAULT_SLOT_MAP's canonical-id self-mapping block above — so a row already
 * pre-resolved to a custom lift's id, e.g. via liftOverrides, passes strict
 * validation without a separate name-based alias).
 *
 * DEFAULT_SLOT_MAP always wins on a name collision: its keys are shared,
 * global vocabulary that every program template and every user's imports rely
 * on, so a custom lift must never be able to shadow a canonical abbreviation
 * (e.g. a custom lift literally named "Squat" must not silently redirect
 * canonical squat imports into that one user's custom lift).
 *
 * Built on a null-prototype object, and validateLiftImport/validateLiftImportSoft
 * check membership with Object.hasOwn rather than the `in` operator — a lift
 * whose custom name is "toString", "constructor", "__proto__", etc. must not
 * silently resolve to an inherited Object.prototype member instead of failing
 * validation like any other unrecognized name (issue #911 review).
 */
export function buildEffectiveSlotMap(
  customLifts: readonly CustomLift[],
): Record<string, string> {
  const custom: Record<string, string> = Object.create(null);
  for (const lift of customLifts) {
    custom[lift.name] = lift.id;
    custom[lift.id] = lift.id;
  }
  return Object.assign(Object.create(null), custom, DEFAULT_SLOT_MAP) as Record<string, string>;
}

// Lazily built and cached: ALL_SLOT_MAP_ALIASES is a module-level constant, so
// the lowercased index never goes stale across calls.
let aliasesLowerToCanonical: Map<string, string> | undefined;

/**
 * Case-insensitive collision check against DEFAULT_SLOT_MAP's aliases: does
 * `name` match one once case is ignored? Returns that alias's own canonical
 * casing when it does, undefined otherwise.
 *
 * Backs the "a custom lift must never register under a name that shadows a
 * built-in" rule — a case-variant registers successfully (custom-lift name
 * uniqueness is scoped to the user and is itself exact-case) but
 * buildEffectiveSlotMap always lets DEFAULT_SLOT_MAP win on an *exact*-case
 * collision, so a case-variant custom lift is a distinct, valid entry, not a
 * duplicate — except when the case-*insensitive* match happens to be exact
 * too, which is what actually makes it unreachable by its own name at import
 * time (issue #911 review). Exported so every caller that needs this specific
 * check — currently the custom-lift create/update collision guard in
 * apps/api/src/lifts/custom-lift.controller.ts — reads from one source
 * instead of hand-writing its own case-insensitive scan (third review pass:
 * the guard was duplicated verbatim between create() and update()).
 */
export function canonicalAliasFor(name: string): string | undefined {
  aliasesLowerToCanonical ??= new Map(
    ALL_SLOT_MAP_ALIASES.map((alias) => [alias.toLowerCase(), alias]),
  );
  return aliasesLowerToCanonical.get(name.toLowerCase());
}

// Lazily built and cached, same rationale as aliasesLowerToCanonical above.
let aliasSet: Set<string> | undefined;

/**
 * O(1) EXACT-case membership check against DEFAULT_SLOT_MAP's aliases —
 * deliberately narrower than canonicalAliasFor (case-insensitive) or a set
 * that also includes a user's custom lift names/ids (as ImportWizard.tsx's
 * own exactKnownLiftKeys does): a custom lift's *own* name must never test
 * true here even when exactKnownLiftKeys would include it, or a caller using
 * this to mean "is this an alias, as opposed to a custom lift" would
 * incorrectly treat every custom lift as a shadowing alias of itself. Callers
 * needing "is this ANY known lift" should use their own broader set/map
 * instead — this answers a narrower, different question (issue #911 review,
 * fourth pass — replaces a per-call-site ALL_SLOT_MAP_ALIASES.includes(...)
 * linear scan in ImportWizard.tsx's remap datalist filter).
 */
export function isCanonicalAlias(name: string): boolean {
  aliasSet ??= new Set(ALL_SLOT_MAP_ALIASES);
  return aliasSet.has(name);
}
