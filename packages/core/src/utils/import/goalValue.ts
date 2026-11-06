import { StrengthGoalEntry } from '../../models';

/** A goal as a preview shows it. */
export function goalValue(g: StrengthGoalEntry): string {
  return g.goalType === 'relative'
    ? `${g.ratio}× bodyweight`
    : `${g.target} ${g.unit}`;
}
