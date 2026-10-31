export interface IWorkoutSkipOverrideRepository {
  getSkipsForMacrocycle(program: string, macrocycleNum: number): Promise<Set<number>>;
  skipWorkout(program: string, macrocycleNum: number, workoutNum: number, reason?: string): Promise<void>;
  unskipWorkout(program: string, macrocycleNum: number, workoutNum: number): Promise<void>;
  /** Deletes every skip for a program, across all macrocycles. No-op if none exist. */
  deleteAllSkips(program: string): Promise<void>;
}
