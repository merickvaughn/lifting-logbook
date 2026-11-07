import { StrengthGoalEntry, classifyAndCount, strengthGoalRowKind } from '@lifting-logbook/core';
import { ImportWriteResult } from '@lifting-logbook/types';
import { IStrengthGoalRepository } from '../../ports/IStrengthGoalRepository';
import { StrengthGoalNotFoundError } from '../../ports/errors';

export class InMemoryStrengthGoalRepository implements IStrengthGoalRepository {
  private readonly store = new Map<string, Map<string, StrengthGoalEntry>>();

  private programMap(program: string): Map<string, StrengthGoalEntry> {
    let m = this.store.get(program);
    if (!m) {
      m = new Map();
      this.store.set(program, m);
    }
    return m;
  }

  allByProgram(): (StrengthGoalEntry & { program: string })[] {
    return [...this.store].flatMap(([program, goals]) =>
      [...goals.values()].map((goal) => ({ ...goal, program })),
    );
  }

  async getGoals(program: string): Promise<StrengthGoalEntry[]> {
    return Array.from(this.programMap(program).values());
  }

  async upsertGoal(program: string, goal: StrengthGoalEntry): Promise<StrengthGoalEntry> {
    this.programMap(program).set(goal.lift, goal);
    return goal;
  }

  async importGoals(
    program: string,
    goals: StrengthGoalEntry[],
  ): Promise<ImportWriteResult> {
    const map = this.programMap(program);
    const existingByLift = new Map(map);

    // Shared classify/dedupe/tally loop (#532) so this adapter's counts match the
    // Prisma adapter's and the preview path's for the same input.
    return classifyAndCount(
      goals,
      (g) => g.lift,
      (g) => strengthGoalRowKind(g, existingByLift),
      (g) => {
        map.set(g.lift, g);
      },
    );
  }

  async deleteGoal(program: string, lift: string): Promise<void> {
    const m = this.programMap(program);
    if (!m.has(lift)) throw new StrengthGoalNotFoundError(lift);
    m.delete(lift);
  }
}
