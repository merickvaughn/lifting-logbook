import { PROGRESSION_REPS_LIMITS } from '@lifting-logbook/types';
import type { LiftProgressionType } from '@lifting-logbook/types';

/** How each progression type reads in the UI (#1210). Keyed by the full set, so a new type is a type error here. */
export const PROGRESSION_LABELS: Record<LiftProgressionType, string> = {
  linear: 'Linear: add weight when every set hits the target',
  double: 'Double: work up a rep range, then add weight',
  amrap_gated: 'AMRAP-gated: add weight when set 1 hits the target',
  percent_wave: 'Percent wave: percentages of a max that moves once per wave',
  manual: 'Manual: you pick the load',
};

export type ProgressionNumberField = 'increment' | 'repsLow' | 'repsHigh';

/** The form's editable state: strings for the number inputs, `''` for "no type of its own". */
export interface ProgressionDraft {
  type: LiftProgressionType | '';
  increment: string;
  repsLow: string;
  repsHigh: string;
  /**
   * Number fields holding text the browser couldn't parse. A number input reports `''` for
   * those, which would otherwise read as "unset" and clear the stored value.
   */
  badInput?: readonly ProgressionNumberField[];
}

/** The values to save. With no type chosen, the range is null. */
export interface ProgressionValues {
  type: LiftProgressionType | null;
  increment: number | null;
  repsLow: number | null;
  repsHigh: number | null;
}

const text = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n));

export function progressionDraft(values: {
  type?: LiftProgressionType | null;
  increment?: number | null;
  repsLow?: number | null;
  repsHigh?: number | null;
}): ProgressionDraft {
  return {
    type: values.type ?? '',
    increment: text(values.increment),
    repsLow: text(values.repsLow),
    repsHigh: text(values.repsHigh),
  };
}

export const EMPTY_PROGRESSION_DRAFT: ProgressionDraft = progressionDraft({});

/**
 * Checks the draft the way the API's DTOs do, so the lifter sees the problem before a 400.
 * Returns the values to save, or an error message. With no type chosen the range clears, and
 * so does the increment unless `incrementWithoutType`: a lift's own increment applies
 * whatever type it follows (ADR-043), while a default progression has no increment without
 * a type.
 */
export function parseProgressionDraft(
  draft: ProgressionDraft,
  { incrementWithoutType = false }: { incrementWithoutType?: boolean } = {},
): { values: ProgressionValues } | { error: string } {
  const noType = draft.type === '';
  const bad = draft.badInput ?? [];
  const keepIncrement = !noType || incrementWithoutType;

  if (keepIncrement && bad.includes('increment')) return { error: 'Increment must be a number above 0.' };
  const increment = !keepIncrement || draft.increment.trim() === '' ? null : Number(draft.increment);
  if (increment !== null && !(Number.isFinite(increment) && increment > 0)) {
    return { error: 'Increment must be a number above 0.' };
  }
  if (draft.type === '') return { values: { type: null, increment, repsLow: null, repsHigh: null } };

  const reps = (value: string): number | null | undefined => {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= PROGRESSION_REPS_LIMITS.MIN && n <= PROGRESSION_REPS_LIMITS.MAX
      ? n
      : undefined;
  };
  const repsLow = bad.includes('repsLow') ? undefined : reps(draft.repsLow);
  const repsHigh = bad.includes('repsHigh') ? undefined : reps(draft.repsHigh);
  if (repsLow === undefined || repsHigh === undefined) {
    return {
      error: `Reps must be whole numbers from ${PROGRESSION_REPS_LIMITS.MIN} to ${PROGRESSION_REPS_LIMITS.MAX}.`,
    };
  }
  if (repsLow !== null && repsHigh !== null && repsLow > repsHigh) {
    return { error: 'The bottom of the rep range must not be above the top.' };
  }
  return { values: { type: draft.type, increment, repsLow, repsHigh } };
}
