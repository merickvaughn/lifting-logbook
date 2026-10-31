import { PrismaClient } from '@prisma/client';
import { IWorkoutSkipOverrideRepository } from '../../ports/IWorkoutSkipOverrideRepository';

export class PrismaWorkoutSkipOverrideRepository implements IWorkoutSkipOverrideRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getSkipsForMacrocycle(program: string, macrocycleNum: number): Promise<Set<number>> {
    const rows = await this.prisma.workoutSkipOverride.findMany({
      where: { userId: this.userId, program, macrocycleNum },
      select: { workoutNum: true },
    });
    return new Set(rows.map((r) => r.workoutNum));
  }

  async skipWorkout(program: string, macrocycleNum: number, workoutNum: number, reason?: string): Promise<void> {
    await this.prisma.workoutSkipOverride.upsert({
      where: { userId_program_macrocycleNum_workoutNum: { userId: this.userId, program, macrocycleNum, workoutNum } },
      update: { reason: reason ?? null, skippedAt: new Date() },
      create: { userId: this.userId, program, macrocycleNum, workoutNum, reason: reason ?? null },
    });
  }

  async unskipWorkout(program: string, macrocycleNum: number, workoutNum: number): Promise<void> {
    await this.prisma.workoutSkipOverride.deleteMany({
      where: { userId: this.userId, program, macrocycleNum, workoutNum },
    });
  }

  async deleteAllSkips(program: string): Promise<void> {
    await this.prisma.workoutSkipOverride.deleteMany({
      where: { userId: this.userId, program },
    });
  }
}
