export interface IWorkoutSkipOverrideRepository {
  getSkipsForMacrocycle(program: string, macrocycleNum: number): Promise<Set<number>>;
  skipWorkout(program: string, macrocycleNum: number, workoutNum: number, reason?: string): Promise<void>;
  unskipWorkout(program: string, macrocycleNum: number, workoutNum: number): Promise<void>;
}
