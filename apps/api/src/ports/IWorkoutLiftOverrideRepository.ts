import type { LiftOverride } from '@lifting-logbook/core';

// A domain model (packages/core), shared with applyLiftOverrides; re-exported so
// adapters and mappers keep importing it from their port.
export type { LiftOverride };

/**
 * The actions whose override, for the same lift, saving one with `action`
 * replaces. A lift keeps one override of each kind: whether the workout has it
 * (`add` or `remove`), and what its slot holds now (`replace`). So replacing an
 * added lift keeps the add that put it in the workout, and the replace has a
 * lift to swap; overwriting the add left neither lift planned (#1026).
 */
export function sameKindActions(action: LiftOverride['action']): LiftOverride['action'][] {
  return action === 'replace' ? ['replace'] : ['add', 'remove'];
}

export interface IWorkoutLiftOverrideRepository {
  /**
   * The workout's overrides in the order each was last written: saving an
   * override again moves it to the end. `applyLiftOverrides` depends on it: a
   * chain of swaps, or a swap made again after being undone, only resolves when
   * applied in that sequence. A lift has at most one override of each kind (see
   * {@link sameKindActions}).
   */
  getOverrides(
    program: string,
    cycleNum: number,
    workoutNum: number,
  ): Promise<LiftOverride[]>;

  /** Saves `override`, replacing the lift's override of the same kind if it has one. */
  upsertOverride(
    program: string,
    cycleNum: number,
    workoutNum: number,
    override: LiftOverride,
  ): Promise<void>;

  /** Deletes every override of `lift`, of either kind. */
  deleteOverride(
    program: string,
    cycleNum: number,
    workoutNum: number,
    lift: string,
  ): Promise<void>;
}
