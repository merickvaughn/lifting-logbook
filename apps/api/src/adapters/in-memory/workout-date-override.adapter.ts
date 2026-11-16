import { IWorkoutDateOverrideRepository } from '../../ports/IWorkoutDateOverrideRepository';
import { TrainingRow } from '../../ports/ITrainingDataRepository';
import { NumberedStore, dropFromMap, nulKey, numbersInMap, rekeyMap } from './renumber';
import { TrainingStore, numberOf } from './training-data.adapter';

export class InMemoryWorkoutDateOverrideRepository
  implements IWorkoutDateOverrideRepository, NumberedStore, TrainingStore
{
  private readonly store = new Map<string, Date>();

  readonly trainingTable = 'workoutDateOverrides';

  trainingRows(): TrainingRow[] {
    return [...this.store].map(([key, newDate]) => {
      const [program = '', macrocycleNum, workoutNum] = key.split('\0');
      return { program, macrocycleNum: Number(macrocycleNum), workoutNum: Number(workoutNum), newDate };
    });
  }

  clearTraining(): void {
    this.store.clear();
  }

  restoreTraining(rows: readonly TrainingRow[]): number {
    let added = 0;
    for (const row of rows) {
      const key = this.key(row.program, numberOf(row, 'macrocycleNum'), numberOf(row, 'workoutNum'));
      if (this.store.has(key)) continue;
      this.store.set(key, row.newDate as Date);
      added++;
    }
    return added;
  }

  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number {
    return rekeyMap(this.store, program, changes, nulKey.numberOf, nulKey.keyWith);
  }

  readonly table = 'workout_date_override';

  numbersHeld(program: string): Set<number> {
    return numbersInMap(this.store, program, nulKey.numberOf);
  }

  dropNumbers(program: string, macrocycleNums: readonly number[]): void {
    dropFromMap(this.store, program, macrocycleNums, nulKey.numberOf);
  }

  private key(program: string, macrocycleNum: number, workoutNum: number): string {
    // Use null byte as delimiter — program slugs cannot contain \0, so this is unambiguous
    // even for slugs like "5-3-1" that contain hyphens.
    return `${program}\0${macrocycleNum}\0${workoutNum}`;
  }

  async getOverridesForMacrocycle(program: string, macrocycleNum: number): Promise<Map<number, Date>> {
    const result = new Map<number, Date>();
    for (const [k, date] of this.store) {
      const parts = k.split('\0');
      if (parts[0] === program && Number(parts[1]) === macrocycleNum) {
        result.set(Number(parts[2]), date);
      }
    }
    return result;
  }

  async getOverride(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
  ): Promise<Date | null> {
    return this.store.get(this.key(program, macrocycleNum, workoutNum)) ?? null;
  }

  async upsertOverride(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    newDate: Date,
  ): Promise<void> {
    this.store.set(this.key(program, macrocycleNum, workoutNum), newDate);
  }
}
