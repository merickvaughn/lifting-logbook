import { MUSCLE_GROUPS, type MuscleTargets } from '@lifting-logbook/types';
import { builtInLiftFor } from './builtInLift';

/**
 * A user's override of the muscles a lift trains — the `LiftMetadata` fields this module
 * reads. Declared structurally so core takes no dependency on the API response shape;
 * `LiftMetadataResponse` satisfies it.
 */
export interface MuscleOverride {
  lift: string;
  muscleGroups: readonly string[];
  /** Absent on rows written before secondary muscles existed; read as empty. */
  secondaryMuscleGroups?: readonly string[];
}

/** Where a lift's resolved muscles came from. */
export type MuscleTargetSource = 'custom' | 'default' | 'none';

/**
 * The muscles a lift's working sets count toward, after overrides and defaults are
 * applied. Labels are canonical: a {@link MUSCLE_GROUPS} name wherever one matches
 * case-insensitively, otherwise the user's own trimmed text.
 */
export interface ResolvedMuscleTargets {
  primary: readonly string[];
  secondary: readonly string[];
  source: MuscleTargetSource;
}

/** The built-in default muscles for a lift name, or undefined when it is not a built-in. */
export function defaultMuscleTargetsFor(name: string): MuscleTargets | undefined {
  return builtInLiftFor(name)?.muscles;
}

const CANONICAL_BY_LOWER: ReadonlyMap<string, string> = new Map(
  MUSCLE_GROUPS.map((group) => [group.toLowerCase(), group] as const),
);

/**
 * `'quads'` → `'Quads'`, `' upper back '` → `'Upper Back'`. Text outside the vocabulary
 * (a user's legacy free-text tag) is trimmed and kept as written, so it still counts —
 * under its own row — instead of vanishing.
 */
export function canonicalMuscleGroup(label: string): string {
  const trimmed = label.trim();
  return CANONICAL_BY_LOWER.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Canonicalizes, drops blanks, and dedupes case-insensitively, keeping first-seen order. */
function canonicalList(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const label = canonicalMuscleGroup(raw);
    const key = label.toLowerCase();
    if (label === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Override rows written through the lift editor before issue #1017's fix carry their
 * lift name still URL-encoded ("Bench%20Press"): the edit route handed its raw dynamic
 * param straight to the API client, which encoded it again. Decoding on read lets those
 * rows apply. A name that is not valid percent-encoding is kept exactly as stored.
 */
function decodeStoredLiftName(lift: string): string {
  try {
    return decodeURIComponent(lift);
  } catch {
    // fallback-covered-by: packages/core/tests/core/catalog/muscles.test.ts
    return lift;
  }
}

/**
 * Builds a lookup from lift name to the muscles its working sets count toward.
 *
 * Precedence, per lift name:
 *   1. the user's override on that **exact** name, when either list is non-empty — both
 *      empty is how a row says "use the defaults";
 *   2. the built-in default, when the name resolves to a catalog lift (by display name,
 *      id, per-entry alias or slot name — see `builtInLiftFor`);
 *   3. nothing (`source: 'none'`) — the caller reports the lift as not counted.
 *
 * Overrides deliberately do not follow aliases: an override set on "Squat" does not
 * apply to "Back Squat". Every other per-lift attribute in `LiftMetadata` is exact-name
 * too, and alias-following would let two rows claim one lift, leaving the editor's
 * "reset to defaults" unable to say which it resets (ADR-036).
 *
 * A muscle listed as both primary and secondary counts as primary only.
 */
export function buildMuscleTargetResolver(
  overrides: readonly MuscleOverride[],
): (lift: string) => ResolvedMuscleTargets {
  const byLift = new Map<string, MuscleOverride>();
  for (const override of overrides) {
    const lift = decodeStoredLiftName(override.lift);
    // A row stored under the real name always beats a legacy encoded twin, whichever
    // order the API returned them in.
    if (lift !== override.lift && byLift.has(lift)) continue;
    byLift.set(lift, override);
  }

  return (lift) => {
    const override = byLift.get(lift);
    if (override) {
      const primary = canonicalList(override.muscleGroups);
      const inPrimary = new Set(primary.map((label) => label.toLowerCase()));
      const secondary = canonicalList(override.secondaryMuscleGroups ?? []).filter(
        (label) => !inPrimary.has(label.toLowerCase()),
      );
      if (primary.length > 0 || secondary.length > 0) {
        return { primary, secondary, source: 'custom' };
      }
    }
    const defaults = defaultMuscleTargetsFor(lift);
    if (defaults) {
      return { primary: defaults.primary, secondary: defaults.secondary, source: 'default' };
    }
    return { primary: [], secondary: [], source: 'none' };
  };
}
