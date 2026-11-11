/**
 * How a lift's training max moves (issue #1206; proposal
 * `docs/proposals/2026-11-10-lift-progression-types.md`):
 * - `linear` — every set of the session reaches the target reps, so the max becomes that
 *   weight plus the increment; a missed set holds the weight;
 * - `double` — work up a rep range at one weight; once every set reaches the top, the max
 *   becomes that weight plus the increment and the plan drops to the bottom of the range;
 * - `amrap_gated` — today's rule: in a training week, set 1 at or above the target reps
 *   makes the max that weight plus the increment;
 * - `percent_wave` — plan percentages of the max, which moves by the increment once per wave;
 * - `manual` — the lifter picks the load and the max never moves on its own;
 * - `rpe` — load chosen to hit a target RPE. Shared with focus blocks, which already use it;
 *   not selectable on a lift until per-set RPE logging exists.
 *
 * Test weeks, deloads and reduction flagging behave the same under every type.
 */
export const PROGRESSION_TYPES = ['linear', 'double', 'amrap_gated', 'percent_wave', 'manual', 'rpe'] as const;
export type ProgressionType = (typeof PROGRESSION_TYPES)[number];

/**
 * The types a lifter may set on a lift, as its own value, their default, or a program's spec
 * row (#1210): every type but `rpe`, which needs per-set RPE logging first.
 */
export const LIFT_PROGRESSION_TYPES = ['linear', 'double', 'amrap_gated', 'percent_wave', 'manual'] as const;
export type LiftProgressionType = (typeof LIFT_PROGRESSION_TYPES)[number];

/**
 * Read-side guard for a stored type. The columns have no CHECK constraint, only DTO
 * validation on write, so an adapter reads an unknown value as unset rather than trust it.
 */
export function isLiftProgressionType(value: unknown): value is LiftProgressionType {
  return (LIFT_PROGRESSION_TYPES as readonly unknown[]).includes(value);
}

/** Bounds on a lift's or the default's rep range (#1210). A spec row's reps stay 1 to 20. */
export const PROGRESSION_REPS_LIMITS = { MIN: 1, MAX: 50 } as const;

/**
 * The lifter's default progression from Settings (#1210): the type plus an optional increment
 * and rep range. Unset (`null` on `UserSettingsResponse`) means each lift's catalog default
 * applies. Shaped to pass straight to core's `resolveProgression` as its `userDefault`.
 */
export interface DefaultProgressionSetting {
  type: LiftProgressionType;
  increment: number | null;
  repsLow: number | null;
  repsHigh: number | null;
}
