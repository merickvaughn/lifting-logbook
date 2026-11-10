export interface IWorkoutDateOverrideRepository {
  getOverride(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
  ): Promise<Date | null>;

  getOverridesForMacrocycle(
    program: string,
    macrocycleNum: number,
  ): Promise<Map<number, Date>>;

  upsertOverride(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    newDate: Date,
  ): Promise<void>;

  /**
   * Deletes every date override for a program, across all macrocycles except those numbered in
   * `keep`. No-op if none exist.
   */
  deleteAllOverrides(program: string, keep?: readonly number[]): Promise<void>;
}
