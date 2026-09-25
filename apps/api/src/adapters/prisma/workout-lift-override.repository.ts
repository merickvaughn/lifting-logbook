import { PrismaClient } from '@prisma/client';
import { LiftOverride, IWorkoutLiftOverrideRepository } from '../../ports/IWorkoutLiftOverrideRepository';
import { runBatch } from './prisma-tx.util';

export class PrismaWorkoutLiftOverrideRepository
  implements IWorkoutLiftOverrideRepository
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getOverrides(
    program: string,
    cycleNum: number,
    workoutNum: number,
  ): Promise<LiftOverride[]> {
    const rows = await this.prisma.workoutLiftOverride.findMany({
      where: { userId: this.userId, program, cycleNum, workoutNum },
      // The order each override was last written, which the port promises:
      // upsertOverride re-creates a re-saved row, so `createdAt` is its last write.
      // Without an ORDER BY Postgres may return rows in index order (alphabetical
      // by `lift`), and a chain of swaps would resolve out of sequence.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // mirrors WorkoutLiftOverride schema
    return rows.map((r: { lift: string; action: string; replacedBy: string | null }) => ({
      lift: r.lift,
      action: r.action as LiftOverride['action'],
      ...(r.replacedBy !== null && { replacedBy: r.replacedBy }),
    }));
  }

  async upsertOverride(
    program: string,
    cycleNum: number,
    workoutNum: number,
    override: LiftOverride,
  ): Promise<void> {
    // Delete-then-create rather than an in-place update, so a re-saved override
    // moves to the end of the order getOverrides returns. An update would keep
    // the row's original `createdAt`: a swap made again after being undone would
    // then be applied before the undo, and silently change nothing (#1014).
    await runBatch(this.prisma, (db) => [
      db.workoutLiftOverride.deleteMany({
        where: { userId: this.userId, program, cycleNum, workoutNum, lift: override.lift },
      }),
      db.workoutLiftOverride.create({
        data: {
          userId: this.userId,
          program,
          cycleNum,
          workoutNum,
          lift: override.lift,
          action: override.action,
          replacedBy: override.replacedBy ?? null,
        },
      }),
    ]);
  }

  async deleteOverride(
    program: string,
    cycleNum: number,
    workoutNum: number,
    lift: string,
  ): Promise<void> {
    await this.prisma.workoutLiftOverride.deleteMany({
      where: { userId: this.userId, program, cycleNum, workoutNum, lift },
    });
  }
}
