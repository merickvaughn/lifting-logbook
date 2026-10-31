import { PrismaClient } from '@prisma/client';
import { IWorkoutDateOverrideRepository } from '../../ports/IWorkoutDateOverrideRepository';

export class PrismaWorkoutDateOverrideRepository
  implements IWorkoutDateOverrideRepository
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getOverride(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
  ): Promise<Date | null> {
    const row = await this.prisma.workoutDateOverride.findUnique({
      where: {
        userId_program_macrocycleNum_workoutNum: {
          userId: this.userId,
          program,
          macrocycleNum,
          workoutNum,
        },
      },
    });
    return row?.newDate ?? null;
  }

  async getOverridesForMacrocycle(program: string, macrocycleNum: number): Promise<Map<number, Date>> {
    const rows = await this.prisma.workoutDateOverride.findMany({
      where: { userId: this.userId, program, macrocycleNum },
    });
    return new Map(rows.map((r) => [r.workoutNum, r.newDate]));
  }

  async upsertOverride(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    newDate: Date,
  ): Promise<void> {
    await this.prisma.workoutDateOverride.upsert({
      where: {
        userId_program_macrocycleNum_workoutNum: {
          userId: this.userId,
          program,
          macrocycleNum,
          workoutNum,
        },
      },
      create: { userId: this.userId, program, macrocycleNum, workoutNum, newDate },
      update: { newDate },
    });
  }

  async deleteAllOverrides(program: string): Promise<void> {
    await this.prisma.workoutDateOverride.deleteMany({
      where: { userId: this.userId, program },
    });
  }
}
