import { LiftRecord } from '@lifting-logbook/core';

export interface IWorkoutRepository {
  getWorkout(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
  ): Promise<LiftRecord[]>;

  saveWorkout(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    records: LiftRecord[],
  ): Promise<void>;
}
