import type { LiftOverride } from '@lifting-logbook/core';

// A domain model (packages/core), shared with applyLiftOverrides; re-exported so
// adapters and mappers keep importing it from their port.
export type { LiftOverride };

export interface IWorkoutLiftOverrideRepository {
  /**
   * The workout's overrides in the order each was last written: saving an
   * override for a lift again moves it to the end. `applyLiftOverrides` depends
   * on it: a chain of swaps, or a swap made again after being undone, only
   * resolves when applied in that sequence.
   */
  getOverrides(
    program: string,
    cycleNum: number,
    workoutNum: number,
  ): Promise<LiftOverride[]>;

  upsertOverride(
    program: string,
    cycleNum: number,
    workoutNum: number,
    override: LiftOverride,
  ): Promise<void>;

  deleteOverride(
    program: string,
    cycleNum: number,
    workoutNum: number,
    lift: string,
  ): Promise<void>;
}
