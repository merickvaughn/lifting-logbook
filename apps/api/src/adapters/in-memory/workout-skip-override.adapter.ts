import { IWorkoutSkipOverrideRepository } from '../../ports/IWorkoutSkipOverrideRepository';

export class InMemoryWorkoutSkipOverrideRepository implements IWorkoutSkipOverrideRepository {
  private readonly store = new Map<string, Set<number>>();

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

  async deleteAllSkips(program: string): Promise<void> {
    for (const k of this.store.keys()) {
      if (k.slice(0, k.lastIndexOf(':')) === program) this.store.delete(k);
    }
  }
}
