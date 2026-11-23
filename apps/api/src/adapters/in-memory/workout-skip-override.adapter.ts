import { IWorkoutSkipOverrideRepository } from '../../ports/IWorkoutSkipOverrideRepository';
import { TrainingRow } from '../../ports/ITrainingDataRepository';
import { NumberedStore, colonKey, dropFromMap, numbersInMap, rekeyMap } from './renumber';
import { TrainingStore, numberOf } from './training-data.adapter';

export class InMemoryWorkoutSkipOverrideRepository
  implements IWorkoutSkipOverrideRepository, NumberedStore, TrainingStore
{
  /** Each macrocycle's skipped workouts, with the reason given, else null. */
  private readonly store = new Map<string, Map<number, string | null>>();

  readonly trainingTable = 'workoutSkipOverrides';

  trainingRows(): TrainingRow[] {
    return [...this.store].flatMap(([key, skipped]) => {
      const { program, macrocycleNum } = colonKey.numberOf(key);
      return [...skipped].map(([workoutNum, reason]) => ({ program, macrocycleNum, workoutNum, reason }));
    });
  }

  clearTraining(): void {
    this.store.clear();
  }

  restoreTraining(rows: readonly TrainingRow[]): number {
    let added = 0;
    for (const row of rows) {
      const key = this.key(row.program, numberOf(row, 'macrocycleNum'));
      const skipped = this.store.get(key) ?? new Map<number, string | null>();
      if (skipped.has(numberOf(row, 'workoutNum'))) continue;
      skipped.set(numberOf(row, 'workoutNum'), typeof row['reason'] === 'string' ? row['reason'] : null);
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
    return new Set(this.store.get(this.key(program, macrocycleNum))?.keys() ?? []);
  }

  async getSkipReasonsForMacrocycle(program: string, macrocycleNum: number): Promise<Map<number, string | null>> {
    return new Map(this.store.get(this.key(program, macrocycleNum)) ?? []);
  }

  async skipWorkout(program: string, macrocycleNum: number, workoutNum: number, reason?: string): Promise<void> {
    const k = this.key(program, macrocycleNum);
    const skipped = this.store.get(k) ?? new Map<number, string | null>();
    skipped.set(workoutNum, reason ?? null);
    this.store.set(k, skipped);
  }

  async unskipWorkout(program: string, macrocycleNum: number, workoutNum: number): Promise<void> {
    this.store.get(this.key(program, macrocycleNum))?.delete(workoutNum);
  }
}
