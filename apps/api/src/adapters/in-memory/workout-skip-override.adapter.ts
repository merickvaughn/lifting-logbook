import { IWorkoutSkipOverrideRepository } from '../../ports/IWorkoutSkipOverrideRepository';
import { TrainingRow } from '../../ports/ITrainingDataRepository';
import { NumberedStore, colonKey, dropFromMap, numbersInMap, rekeyMap } from './renumber';
import { TrainingStore, numberOf } from './training-data.adapter';

export class InMemoryWorkoutSkipOverrideRepository
  implements IWorkoutSkipOverrideRepository, NumberedStore, TrainingStore
{
  private readonly store = new Map<string, Set<number>>();

  readonly trainingTable = 'workoutSkipOverrides';

  trainingRows(): TrainingRow[] {
    return [...this.store].flatMap(([key, workoutNums]) => {
      const { program, macrocycleNum } = colonKey.numberOf(key);
      return [...workoutNums].map((workoutNum) => ({ program, macrocycleNum, workoutNum }));
    });
  }

  clearTraining(): void {
    this.store.clear();
  }

  restoreTraining(rows: readonly TrainingRow[]): number {
    let added = 0;
    for (const row of rows) {
      const key = this.key(row.program, numberOf(row, 'macrocycleNum'));
      const skipped = this.store.get(key) ?? new Set<number>();
      if (skipped.has(numberOf(row, 'workoutNum'))) continue;
      skipped.add(numberOf(row, 'workoutNum'));
      this.store.set(key, skipped);
      added++;
    }
    return added;
  }

  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number {
    return rekeyMap(this.store, program, changes, colonKey.numberOf, colonKey.keyWith);
  }

  readonly table = 'workout_skip_override';

  numbersHeld(program: string): Set<number> {
    return numbersInMap(this.store, program, colonKey.numberOf);
  }

  dropNumbers(program: string, macrocycleNums: readonly number[]): void {
    dropFromMap(this.store, program, macrocycleNums, colonKey.numberOf);
  }

  private key(program: string, macrocycleNum: number): string {
    return `${program}:${macrocycleNum}`;
  }

  async getSkipsForMacrocycle(program: string, macrocycleNum: number): Promise<Set<number>> {
    return new Set(this.store.get(this.key(program, macrocycleNum)) ?? []);
  }

  async skipWorkout(program: string, macrocycleNum: number, workoutNum: number, _reason?: string): Promise<void> {
    const k = this.key(program, macrocycleNum);
    const set = this.store.get(k) ?? new Set<number>();
    set.add(workoutNum);
    this.store.set(k, set);
  }

  async unskipWorkout(program: string, macrocycleNum: number, workoutNum: number): Promise<void> {
    this.store.get(this.key(program, macrocycleNum))?.delete(workoutNum);
  }
}
