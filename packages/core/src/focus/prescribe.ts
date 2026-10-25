import type { FocusBlock, FocusPoolEntry } from '@lifting-logbook/types';
import { MROUND } from '../constants/config';

/** How many pounds a double-progression lift goes up once every set hits the top of the range. */
export const FOCUS_DOUBLE_PROGRESSION_STEP = 5;

export type FocusPrescription =
  | {
      progression: 'double';
      sets: number;
      repsLow: number;
      repsHigh: number;
      weight: number;
      lastReps: readonly number[] | null;
    }
  | { progression: 'fixed'; sets: number; reps: number; weight: number }
  | { progression: 'tm'; sets: number; reps: number; weight: number; percent: number; trainingMax: number }
  | { progression: 'rpe'; sets: number; reps: number; rpe: number; repsInReserve: number };

/**
 * A focus lift's prescription for `sets` sets under its block's progression.
 *
 * Double and fixed progression use the entry's weight as entered, never rounded. A percent
 * of training max is a computed per-workout weight, so it rounds to the nearest loadable
 * plate combination at `increment` (docs/standards/training-max-precision.md, rule 3).
 */
export function prescribe(
  block: Pick<FocusBlock, 'progression'>,
  entry: FocusPoolEntry,
  sets: number,
  increment = 2.5,
): FocusPrescription {
  switch (block.progression) {
    case 'fixed':
      return { progression: 'fixed', sets, reps: entry.repsHigh, weight: entry.weight };
    case 'tm':
      return {
        progression: 'tm',
        sets,
        reps: entry.repsHigh,
        weight: MROUND((entry.trainingMax * entry.percent) / 100, increment),
        percent: entry.percent,
        trainingMax: entry.trainingMax,
      };
    case 'rpe':
      return { progression: 'rpe', sets, reps: entry.repsHigh, rpe: entry.rpe, repsInReserve: 10 - entry.rpe };
    case 'double':
      return {
        progression: 'double',
        sets,
        repsLow: entry.repsLow,
        repsHigh: entry.repsHigh,
        weight: entry.weight,
        lastReps: entry.lastReps ?? null,
      };
  }
}
