/**
 * The date a schedule gave one workout of a macrocycle (issue #1023, ADR-037).
 *
 * A schedule dates the program's workout days; it does not number them. Workout N
 * is the program's N-th `(week, offset)` day (`programWorkoutKeys`), so readers take
 * a workout's week and day from its `workoutNum` and only its date from this row.
 * The one exception is a row past the program's last day. That row has no program
 * day, so if it is opened directly the workout endpoint labels it with the row's
 * own `weekNum`. The dashboard leaves it out.
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

export interface IMacrocycleScheduledWorkoutRepository {
  getScheduledWorkouts(program: string, macrocycleNum: number): Promise<ScheduledWorkout[]>;
  saveScheduledWorkouts(program: string, macrocycleNum: number, workouts: ScheduledWorkout[]): Promise<void>;
}
