import { IMacrocycleScheduledWorkoutRepository, ScheduledWorkout } from '../../ports/IMacrocycleScheduledWorkoutRepository';
import { NumberedStore, colonKey, dropFromMap, numbersInMap, rekeyMap } from './renumber';

export class InMemoryMacrocycleScheduledWorkoutRepository implements IMacrocycleScheduledWorkoutRepository, NumberedStore {
  private readonly store = new Map<string, ScheduledWorkout[]>();

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

  async getScheduledWorkouts(program: string, macrocycleNum: number): Promise<ScheduledWorkout[]> {
    return this.store.get(this.key(program, macrocycleNum)) ?? [];
  }

  async saveScheduledWorkouts(program: string, macrocycleNum: number, workouts: ScheduledWorkout[]): Promise<void> {
    this.store.set(this.key(program, macrocycleNum), [...workouts]);
  }

  async deleteAllScheduledWorkouts(program: string, keep: readonly number[] = []): Promise<void> {
    for (const k of this.store.keys()) {
      const split = k.lastIndexOf(':');
      if (k.slice(0, split) === program && !keep.includes(Number(k.slice(split + 1)))) this.store.delete(k);
    }
  }
}
