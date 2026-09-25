import { LiftOverride, IWorkoutLiftOverrideRepository } from '../../ports/IWorkoutLiftOverrideRepository';

export class InMemoryWorkoutLiftOverrideRepository
  implements IWorkoutLiftOverrideRepository
{
  private readonly store = new Map<string, LiftOverride[]>();

  private key(program: string, cycleNum: number, workoutNum: number): string {
    // Null byte delimiter — program slugs cannot contain \0, unambiguous even for slugs like "5-3-1".
    return `${program}\0${cycleNum}\0${workoutNum}`;
  }

  async getOverrides(
    program: string,
    cycleNum: number,
    workoutNum: number,
  ): Promise<LiftOverride[]> {
    return this.store.get(this.key(program, cycleNum, workoutNum)) ?? [];
  }

  async upsertOverride(
    program: string,
    cycleNum: number,
    workoutNum: number,
    override: LiftOverride,
  ): Promise<void> {
    const k = this.key(program, cycleNum, workoutNum);
    // A re-saved override moves to the end — the order each was last written,
    // matching the Prisma adapter, which re-creates the row (issue #1014).
    const others = (this.store.get(k) ?? []).filter((o) => o.lift !== override.lift);
    this.store.set(k, [...others, override]);
  }

  async deleteOverride(
    program: string,
    cycleNum: number,
    workoutNum: number,
    lift: string,
  ): Promise<void> {
    const k = this.key(program, cycleNum, workoutNum);
    const existing = this.store.get(k) ?? [];
    this.store.set(
      k,
      existing.filter((o) => o.lift !== lift),
    );
  }
}
