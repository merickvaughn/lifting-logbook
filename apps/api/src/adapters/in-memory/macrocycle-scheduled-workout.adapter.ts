import { IMacrocycleScheduledWorkoutRepository, ScheduledWorkout } from '../../ports/IMacrocycleScheduledWorkoutRepository';
import { TrainingRow } from '../../ports/ITrainingDataRepository';
import { NumberedStore, colonKey, dropFromMap, numbersInMap, rekeyMap } from './renumber';
import { TrainingStore, numberOf } from './training-data.adapter';

export class InMemoryMacrocycleScheduledWorkoutRepository
  implements IMacrocycleScheduledWorkoutRepository, NumberedStore, TrainingStore
{
  private readonly store = new Map<string, ScheduledWorkout[]>();

  readonly trainingTable = 'macrocycleScheduledWorkouts';

  trainingRows(): TrainingRow[] {
    return [...this.store].flatMap(([key, workouts]) => {
      const { program, macrocycleNum } = colonKey.numberOf(key);
      return workouts.map((w) => ({ ...w, program, macrocycleNum }));
    });
  }

  clearTraining(): void {
    this.store.clear();
  }

  restoreTraining(rows: readonly TrainingRow[]): number {
    let added = 0;
    for (const row of rows) {
      const { program, macrocycleNum: _macrocycleNum, ...workout } = row;
      const key = this.key(program, numberOf(row, 'macrocycleNum'));
      const stored = this.store.get(key) ?? [];
      if (stored.some((w) => w.workoutNum === workout.workoutNum)) continue;
      this.store.set(key, [...stored, workout as unknown as ScheduledWorkout]);
      added++;
    }
    return added;
  }

  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number {
    return rekeyMap(this.store, program, changes, colonKey.numberOf, colonKey.keyWith);
  }

  readonly table = 'macrocycle_scheduled_workout';

  numbersHeld(program: string): Set<number> {
    return numbersInMap(this.store, program, colonKey.numberOf);
  }

  dropNumbers(program: string, macrocycleNums: readonly number[]): void {
    dropFromMap(this.store, program, macrocycleNums, colonKey.numberOf);
  }

  private key(program: string, macrocycleNum: number): string {
    return `${program}:${macrocycleNum}`;
  }

  async getScheduledWorkouts(program: string, macrocycleNum: number): Promise<ScheduledWorkout[]> {
    return this.store.get(this.key(program, macrocycleNum)) ?? [];
  }

  async saveScheduledWorkouts(program: string, macrocycleNum: number, workouts: ScheduledWorkout[]): Promise<void> {
    this.store.set(this.key(program, macrocycleNum), [...workouts]);
  }
}
