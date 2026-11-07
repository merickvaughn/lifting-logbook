import { floorToIncrement } from "@src/core/constants";

// Brzycki formula (1993) JOPERD 64(1):88-90; valid for reps 1-36 (asymptote beyond that).
export function estimateOneRepMax(weight: number, reps: number): number {
  if (reps <= 0 || weight <= 0) return 0;
  if (reps === 1) return floorToIncrement(weight);
  const denom = 37 - reps;
  if (denom <= 0) return 0;
  return floorToIncrement((weight * 36) / denom);
}

/**
 * Estimates the weight for `targetReps` from a set of `weight` × `reps`, floored like
 * {@link estimateOneRepMax}, and 0 for the same invalid input. It inverts that function:
 * from a one-rep max, `estimateRepMax(oneRepMax, 1, n)` is the weight for n reps.
 *
 * It works from the set, not from a floored one-rep max, because flooring twice
 * understates the set itself: 210 × 3 floors to a 220 one-rep max, which gives 207.5 for 3 reps.
 */
export function estimateRepMax(weight: number, reps: number, targetReps: number): number {
  if (weight <= 0 || reps <= 0 || targetReps <= 0) return 0;
  const denom = 37 - reps;
  const numer = 37 - targetReps;
  if (denom <= 0 || numer <= 0) return 0;
  return floorToIncrement((weight * numer) / denom);
}
