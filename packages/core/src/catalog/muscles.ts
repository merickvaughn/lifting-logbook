import { MUSCLE_GROUPS, type MuscleTargets } from '@lifting-logbook/types';
import { builtInLiftFor, type NamedLift } from './builtInLift';

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
 * The real name behind a legacy URL-encoded override row, or undefined when `lift` does
 * not look like one.
 *
 * Until issue #1017, the lift editor's route handed its still-encoded dynamic param to the
 * API client, so a multi-word override was stored as "Bench%20Press". Those rows carry
 * the bug's exact signature — a `%` and no whitespace, since `encodeURIComponent` never
 * leaves a literal space — and nothing else is decoded: a real name like "Squat %40 RPE"
 * keeps its identity. A name that is not valid percent-encoding is left alone.
 */
function legacyEncodedLiftName(lift: string): string | undefined {
  if (!lift.includes('%') || /\s/.test(lift)) return undefined;
  try {
    const decoded = decodeURIComponent(lift);
    return decoded === lift ? undefined : decoded;
  } catch {
    // fallback-covered-by: packages/core/tests/core/catalog/muscles.test.ts
    return undefined;
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
 * Defaults attach to the *name*: a custom lift that shares a built-in's name or alias
 * ("Cable Row") reads that built-in's defaults until its user overrides them. That is the
 * one place a custom lift yields to a built-in — classification and patterns, which a
 * custom lift records explicitly, follow `lookupLift` — and it is deliberate: a same-named
 * custom lift carries no muscle data of its own, and the name is the best evidence of what
 * it trains.
 *
 * Overrides do not follow aliases: one set on "Squat" leaves "Back Squat" on its defaults.
 * Every other per-lift attribute in `LiftMetadata` is exact-name too, and alias-following
 * would let two rows claim one lift (ADR-036). `customLifts` is consulted only to map a
 * custom lift's uuid — which import can store in a record's `lift` column — to the name its
 * overrides are keyed by.
 *
 * Rows are keyed by their stored name first; a legacy encoded row (see
 * `legacyEncodedLiftName`) is added under its real name only where no row already holds it,
 * so a row stored under the real name always wins. Requirements this places on issue
 * #1017's lift editor: fill the editor from this resolver over all of the user's rows, so a
 * legacy row's tags are shown and carried forward when saved under the real name — filling
 * it from the single-lift GET would save empty lists under the real name and hide them.
 *
 * Returns a closure, which cannot cross the React server → client boundary. Pass the
 * serializable inputs (`MuscleOverride[]`, custom lifts) instead, and build the resolver
 * where it is used.
 *
 * A muscle listed as both primary and secondary counts as primary only.
 */
export function buildMuscleTargetResolver(
  overrides: readonly MuscleOverride[],
  customLifts: readonly NamedLift[] = [],
): (lift: string) => ResolvedMuscleTargets {
  const byLift = new Map<string, MuscleOverride>();
  for (const override of overrides) byLift.set(override.lift, override);
  for (const override of overrides) {
    const realName = legacyEncodedLiftName(override.lift);
    if (realName !== undefined && !byLift.has(realName)) byLift.set(realName, override);
  }
  const nameById = new Map(
    customLifts.flatMap((lift) => (lift.id ? [[lift.id, lift.name] as const] : [])),
  );

  return (lift) => {
    const name = nameById.get(lift) ?? lift;
    const override = byLift.get(name);
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
    const defaults = defaultMuscleTargetsFor(name);
    if (defaults) {
      return { primary: defaults.primary, secondary: defaults.secondary, source: 'default' };
    }
    return { primary: [], secondary: [], source: 'none' };
  };
}
