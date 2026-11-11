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
