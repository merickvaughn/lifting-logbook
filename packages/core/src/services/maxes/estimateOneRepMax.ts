import { ESTIMATE_FLOOR_INCREMENT, floorToIncrement } from "@src/core/constants";

/** The Brzycki formula is valid for 1 to 36 reps; it reaches its asymptote at 37. */
export const MAX_ESTIMATE_REPS = 36;

// Brzycki formula (1993) JOPERD 64(1):88-90.
export function estimateOneRepMax(
  weight: number,
  reps: number,
  increment = ESTIMATE_FLOOR_INCREMENT,
): number {
  return estimateRepMax(weight, reps, 1, increment);
}

/**
 * Estimates the weight for `targetReps` from a set of `weight` × `reps`, floored to
 * `increment`, and 0 for invalid input. It inverts {@link estimateOneRepMax}: from a one-rep
 * max, `estimateRepMax(oneRepMax, 1, n)` is the weight for n reps.
 *
 * It works from the set, not from a floored one-rep max, because flooring twice
 * understates the set itself: 210 × 3 floors to a 220 one-rep max, which gives 207.5 for 3 reps.
 */
export function estimateRepMax(
  weight: number,
  reps: number,
  targetReps: number,
  increment = ESTIMATE_FLOOR_INCREMENT,
): number {
  if (weight <= 0 || reps <= 0) return 0;
  const denom = MAX_ESTIMATE_REPS + 1 - reps;
  if (denom <= 0) return 0;
  return floorToIncrement((weight * (MAX_ESTIMATE_REPS + 1 - targetReps)) / denom, increment);
}
