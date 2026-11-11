import {
  LiftOverride,
  IWorkoutLiftOverrideRepository,
  sameKindActions,
} from '../../ports/IWorkoutLiftOverrideRepository';
import { NumberedStore, dropFromMap, nulKey, numbersInMap, rekeyMap } from './renumber';

export class InMemoryWorkoutLiftOverrideRepository
  implements IWorkoutLiftOverrideRepository, NumberedStore
{
  private readonly store = new Map<string, LiftOverride[]>();

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
    // Null byte delimiter — program slugs cannot contain \0, unambiguous even for slugs like "5-3-1".
    return `${program}\0${macrocycleNum}\0${workoutNum}`;
  }

  async getOverrides(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
  ): Promise<LiftOverride[]> {
    return this.store.get(this.key(program, macrocycleNum, workoutNum)) ?? [];
  }

  async getOverridesForMacrocycle(
    program: string,
    macrocycleNum: number,
  ): Promise<Map<number, LiftOverride[]>> {
    const byWorkout = new Map<number, LiftOverride[]>();
    for (const [k, overrides] of this.store) {
      const [p, m, w] = k.split('\0');
      if (p === program && Number(m) === macrocycleNum && overrides.length > 0) {
        byWorkout.set(Number(w), [...overrides]);
      }
    }
    return byWorkout;
  }

  async upsertOverride(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    override: LiftOverride,
  ): Promise<void> {
    const k = this.key(program, macrocycleNum, workoutNum);
    // A re-saved override moves to the end — the order each was last written,
    // matching the Prisma adapter, which re-creates the row (issue #1014). It
    // replaces only the lift's override of the same kind: a replace keeps the
    // lift's add (#1026).
    const superseded = sameKindActions(override.action);
    const others = (this.store.get(k) ?? []).filter(
      (o) => o.lift !== override.lift || !superseded.includes(o.action),
    );
    this.store.set(k, [...others, override]);
  }

  async deleteOverride(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    lift: string,
  ): Promise<void> {
    const k = this.key(program, macrocycleNum, workoutNum);
    const existing = this.store.get(k) ?? [];
    this.store.set(
      k,
      existing.filter((o) => o.lift !== lift),
    );
  }

  async deleteAllOverrides(program: string, keep: readonly number[] = []): Promise<void> {
    for (const k of this.store.keys()) {
      const [p, m] = k.split('\0');
      if (p === program && !keep.includes(Number(m))) this.store.delete(k);
    }
  }
}
