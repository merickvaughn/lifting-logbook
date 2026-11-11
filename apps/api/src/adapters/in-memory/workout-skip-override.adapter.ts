import { IWorkoutSkipOverrideRepository } from '../../ports/IWorkoutSkipOverrideRepository';
import { NumberedStore, colonKey, dropFromMap, numbersInMap, rekeyMap } from './renumber';

export class InMemoryWorkoutSkipOverrideRepository implements IWorkoutSkipOverrideRepository, NumberedStore {
  private readonly store = new Map<string, Set<number>>();

  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number {
    return rekeyMap(this.store, program, changes, colonKey.numberOf, colonKey.keyWith);
  }

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

  async deleteAllSkips(program: string, keep: readonly number[] = []): Promise<void> {
    for (const k of this.store.keys()) {
      const split = k.lastIndexOf(':');
      if (k.slice(0, split) === program && !keep.includes(Number(k.slice(split + 1)))) this.store.delete(k);
    }
  }
}
