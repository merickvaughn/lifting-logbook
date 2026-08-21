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
 * Unique canonical lift IDs derived from DEFAULT_SLOT_MAP.
 * Used by the REVIEW step's lift-catalog autocomplete datalist.
 */
export const CANONICAL_LIFT_IDS: string[] = [...new Set(Object.values(DEFAULT_SLOT_MAP))];

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
 */
export function buildEffectiveSlotMap(
  customLifts: readonly CustomLift[],
): Record<string, string> {
  const custom: Record<string, string> = {};
  for (const lift of customLifts) {
    custom[lift.name] = lift.id;
    custom[lift.id] = lift.id;
  }
  return { ...custom, ...DEFAULT_SLOT_MAP };
}
