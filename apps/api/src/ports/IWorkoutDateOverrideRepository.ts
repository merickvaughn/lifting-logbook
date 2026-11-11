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
}
