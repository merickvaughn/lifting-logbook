import type { FocusBlock, FocusPoolEntry } from '@lifting-logbook/types';
import { MROUND } from '../constants/config';

export type FocusPrescription =
  | {
      progression: 'double';
      sets: number;
      repsLow: number;
      repsHigh: number;
      weight: number;
      lastReps: readonly number[] | null;
      /** Every last rep reached `repsHigh`, so `weight` is up by the increment. */
      progressed: boolean;
    }
  | { progression: 'manual'; sets: number; reps: number; weight: number }
  | { progression: 'percent_wave'; sets: number; reps: number; weight: number; percent: number; trainingMax: number }
  | { progression: 'rpe'; sets: number; reps: number; rpe: number; repsInReserve: number };

/**
 * A focus lift's prescription for `sets` sets under its block's progression.
 *
 * Manual progression uses the entry's weight as entered, never rounded. Double progression
 * does too, until every rep in `lastReps` reached `repsHigh`: then the plan is that weight
 * plus `increment`, from the bottom of the range (#1213). Nothing is stored for it, so
 * `recordLastSessions` records the weight `lastReps` were done at as `weight` (#1221).
 *
 * A percent of training max is a computed per-workout weight, so it rounds to the nearest
 * loadable plate combination at the program's configured `increment`
 * (docs/standards/training-max-precision.md, rule 3). Its max moves when the block rolls
 * over (`expandRollovers`).
 */
export function prescribe(
  block: Pick<FocusBlock, 'progression'>,
  entry: FocusPoolEntry,
  sets: number,
  increment: number,
): FocusPrescription {
  const progression = block.progression;
  switch (progression) {
    case 'manual':
      return { progression, sets, reps: entry.repsHigh, weight: entry.weight };
    case 'percent_wave':
      return {
        progression,
        sets,
        reps: entry.repsHigh,
        weight: MROUND((entry.trainingMax * entry.percent) / 100, increment),
        percent: entry.percent,
        trainingMax: entry.trainingMax,
      };
    case 'rpe':
      return { progression, sets, reps: entry.repsHigh, rpe: entry.rpe, repsInReserve: 10 - entry.rpe };
    case 'double': {
      const last = entry.lastReps ?? [];
      const progressed = last.length > 0 && last.every((reps) => reps >= entry.repsHigh);
      return {
        progression,
        sets,
        repsLow: entry.repsLow,
        repsHigh: entry.repsHigh,
        weight: progressed ? entry.weight + increment : entry.weight,
        lastReps: entry.lastReps ?? null,
        progressed,
      };
    }
    default: {
      const unknown: never = progression;
      throw new Error(`Unknown focus progression: ${String(unknown)}`);
    }
  }
}
