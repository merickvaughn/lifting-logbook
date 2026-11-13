import { DEFAULT_WEIGHT_INCREMENT, ProgressionType } from '@lifting-logbook/types';
import type { CatalogProgression } from '../../catalog/lifts';

/**
 * The parts of a program's spec row that bear on progression. `reps` is the row's target,
 * and the top of the range when the row names `double`; `increment` is required on every
 * row. `progression` and `repsLow` are optional overrides (added to the spec by #1210).
 */
export interface ProgressionRow {
  progression?: ProgressionType | null;
  repsLow?: number | null;
  reps: number;
  increment: number;
}

/** A lift's own progression, set by the lifter in Manage Lifts (the `lift_metadata` columns). */
export interface LiftProgressionMeta {
  progression?: ProgressionType | null;
  progressionIncrement?: number | null;
  repsLow?: number | null;
  repsHigh?: number | null;
}

/**
 * A stored `lift_metadata` row as `resolveProgression` should read it. A rep range whose bottom
 * is above its top reads as unset, both ends: the PATCH endpoint checks a one-end patch against
 * the stored other end in a separate read, so two overlapping patches can store a crossed range
 * (#1211, from the review of PR #1219).
 */
export function storedLiftProgression(meta: LiftProgressionMeta): LiftProgressionMeta {
  const { repsLow, repsHigh } = meta;
  const crossed = repsLow != null && repsHigh != null && repsLow > repsHigh;
  return crossed ? { ...meta, repsLow: null, repsHigh: null } : meta;
}

/** The lifter's default progression from Settings. Unset (null) means "use the catalog". */
export interface UserProgressionDefault {
  type: ProgressionType;
  increment?: number | null;
  repsLow?: number | null;
  repsHigh?: number | null;
}

/** Where the resolved type and rep range came from. */
export type ProgressionSource = 'row' | 'lift' | 'user' | 'catalog' | 'fallback';

export interface ResolvedProgression {
  type: ProgressionType;
  /** Null when the source that supplied the type gives no rep range bottom. */
  repsLow: number | null;
  /** Null when the source that supplied the type gives no target; the caller decides what that means. */
  repsHigh: number | null;
  increment: number;
  source: ProgressionSource;
}

/**
 * Decides which progression type, rep range and increment apply to a lift
 * (issue #1209; proposal `docs/proposals/2026-11-10-lift-progression-types.md`,
 * "Which value applies").
 *
 * The type and rep range come together from the first source that names a type:
 *   1. the program's spec `row`, when it names one (its range is `repsLow`–`reps`);
 *   2. the lift's own value (`liftMeta`);
 *   3. the lifter's default (`userDefault`), when set;
 *   4. the built-in `catalogLift`'s default;
 *   5. `amrap_gated` with no range, the rule every lift follows today.
 *
 * The increment resolves separately. With a `row` (inside a program) the row's required
 * `increment` always applies, whatever source supplied the type. Without one, it is the
 * lift's own increment, then the lifter's default's, then `defaultWeightIncrement`, then
 * `DEFAULT_WEIGHT_INCREMENT`. The catalog carries no increment.
 *
 * Pure: it reads only its arguments. `updateMaxes` dispatches on its result (#1211), and the
 * workout logger plans by it.
 */
export function resolveProgression(
  row: ProgressionRow | null | undefined,
  liftMeta: LiftProgressionMeta | null | undefined,
  userDefault: UserProgressionDefault | null | undefined,
  catalogLift: { progression: CatalogProgression } | null | undefined,
  defaultWeightIncrement?: number | null,
): ResolvedProgression {
  const increment = row
    ? row.increment
    : liftMeta?.progressionIncrement ?? userDefault?.increment ?? defaultWeightIncrement ?? DEFAULT_WEIGHT_INCREMENT;

  if (row?.progression) {
    return { type: row.progression, repsLow: row.repsLow ?? null, repsHigh: row.reps, increment, source: 'row' };
  }
  if (liftMeta?.progression) {
    return {
      type: liftMeta.progression,
      repsLow: liftMeta.repsLow ?? null,
      repsHigh: liftMeta.repsHigh ?? null,
      increment,
      source: 'lift',
    };
  }
  if (userDefault) {
    return {
      type: userDefault.type,
      repsLow: userDefault.repsLow ?? null,
      repsHigh: userDefault.repsHigh ?? null,
      increment,
      source: 'user',
    };
  }
  if (catalogLift) {
    const { type, repsLow, repsHigh } = catalogLift.progression;
    return { type, repsLow: repsLow ?? null, repsHigh: repsHigh ?? null, increment, source: 'catalog' };
  }
  return { type: 'amrap_gated', repsLow: null, repsHigh: null, increment, source: 'fallback' };
}
