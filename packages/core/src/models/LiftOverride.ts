import type { LiftOverrideAction } from '@lifting-logbook/types';

/**
 * One Manage Lifts override on a single workout: `add` a lift, `remove` one, or
 * `replace` one with `replacedBy`. Overrides stand in for the workout row the
 * schema does not store (docs/domain-model.md §3). What they mean — for the plan
 * and for the logged sets alike — is defined once, by `applyLiftOverrides`.
 */
export interface LiftOverride {
  lift: string;
  action: LiftOverrideAction;
  replacedBy?: string;
}
