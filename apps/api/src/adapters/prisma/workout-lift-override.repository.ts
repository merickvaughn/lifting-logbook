import { PrismaClient } from '@prisma/client';
import { LiftOverride, IWorkoutLiftOverrideRepository } from '../../ports/IWorkoutLiftOverrideRepository';

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
      // Creation order, which the port promises: without an ORDER BY Postgres may
      // return rows in index order (alphabetical by `lift`), and a chain of swaps
      // would then resolve out of sequence. An upsert keeps its row's `createdAt`,
      // matching the in-memory adapter, which replaces an override in place.
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
    await this.prisma.workoutLiftOverride.upsert({
      where: {
        userId_program_cycleNum_workoutNum_lift: {
          userId: this.userId,
          program,
          cycleNum,
          workoutNum,
          lift: override.lift,
        },
      },
      create: {
        userId: this.userId,
        program,
        cycleNum,
        workoutNum,
        lift: override.lift,
        action: override.action,
        replacedBy: override.replacedBy ?? null,
      },
      update: {
        action: override.action,
        replacedBy: override.replacedBy ?? null,
      },
    });
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
