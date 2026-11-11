import { IWorkoutDateOverrideRepository } from '../../ports/IWorkoutDateOverrideRepository';
import { NumberedStore, dropFromMap, nulKey, numbersInMap, rekeyMap } from './renumber';

export class InMemoryWorkoutDateOverrideRepository
  implements IWorkoutDateOverrideRepository, NumberedStore
{
  private readonly store = new Map<string, Date>();

  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number {
    return rekeyMap(this.store, program, changes, nulKey.numberOf, nulKey.keyWith);
  }

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

  async deleteAllOverrides(program: string, keep: readonly number[] = []): Promise<void> {
    for (const k of this.store.keys()) {
      const [p, m] = k.split('\0');
      if (p === program && !keep.includes(Number(m))) this.store.delete(k);
    }
  }
}
