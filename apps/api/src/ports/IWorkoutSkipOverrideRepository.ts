export interface IWorkoutSkipOverrideRepository {
  getSkipsForMacrocycle(program: string, macrocycleNum: number): Promise<Set<number>>;
  /** Every skipped workout in a macrocycle, keyed by `workoutNum`, with its reason, else null. */
  getSkipReasonsForMacrocycle(program: string, macrocycleNum: number): Promise<Map<number, string | null>>;
  skipWorkout(program: string, macrocycleNum: number, workoutNum: number, reason?: string): Promise<void>;
  unskipWorkout(program: string, macrocycleNum: number, workoutNum: number): Promise<void>;
}
