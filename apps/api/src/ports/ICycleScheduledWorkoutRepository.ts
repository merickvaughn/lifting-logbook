/**
 * The date a schedule gave one workout of a cycle (issue #1023, ADR-037).
 *
 * A schedule dates the program's workout days; it does not number them. Workout N
 * is the program's N-th `(week, offset)` day (`programWorkoutKeys`), so readers take
 * a workout's week and day from its `workoutNum` and only its date from this row.
 */
export interface ScheduledWorkout {
  workoutNum: number;
  /**
   * The program week of the workout's day. Rows saved before #1023 hold the
   * calendar week of the schedule instead, which is why readers derive the week
   * from `workoutNum`.
   */
  weekNum: number;
  scheduledDate: Date;
}

export interface ICycleScheduledWorkoutRepository {
  getScheduledWorkouts(program: string, cycleNum: number): Promise<ScheduledWorkout[]>;
  saveScheduledWorkouts(program: string, cycleNum: number, workouts: ScheduledWorkout[]): Promise<void>;
}
