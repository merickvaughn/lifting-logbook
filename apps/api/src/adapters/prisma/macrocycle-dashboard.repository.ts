import { PrismaClient } from '@prisma/client';
import { MacrocycleDashboard, Weekday } from '@lifting-logbook/core';
import { IMacrocycleDashboardRepository } from '../../ports/IMacrocycleDashboardRepository';
import { ProgramNotFoundError } from '../../ports/errors';

export class PrismaMacrocycleDashboardRepository implements IMacrocycleDashboardRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getMacrocycleDashboard(program: string): Promise<MacrocycleDashboard> {
    const row = await this.prisma.macrocycleDashboard.findUnique({
      where: { userId_program: { userId: this.userId, program } },
    });
    if (!row) throw new ProgramNotFoundError(program);
    return {
      program: row.program,
      macrocycleUnit: row.macrocycleUnit,
      macrocycleNum: row.macrocycleNum,
      macrocycleDate: row.macrocycleDate,
      sheetName: row.sheetName,
      macrocycleStartWeekday: row.macrocycleStartWeekday as Weekday,
      ...(row.programType !== null && { programType: row.programType }),
    };
  }

  async saveMacrocycleDashboard(dashboard: MacrocycleDashboard): Promise<void> {
    await this.prisma.macrocycleDashboard.upsert({
      where: { userId_program: { userId: this.userId, program: dashboard.program } },
      create: {
        userId: this.userId,
        program: dashboard.program,
        macrocycleUnit: dashboard.macrocycleUnit,
        macrocycleNum: dashboard.macrocycleNum,
        macrocycleDate: dashboard.macrocycleDate,
        sheetName: dashboard.sheetName,
        macrocycleStartWeekday: dashboard.macrocycleStartWeekday,
        programType: dashboard.programType ?? null,
      },
      update: {
        macrocycleUnit: dashboard.macrocycleUnit,
        macrocycleNum: dashboard.macrocycleNum,
        macrocycleDate: dashboard.macrocycleDate,
        sheetName: dashboard.sheetName,
        macrocycleStartWeekday: dashboard.macrocycleStartWeekday,
        programType: dashboard.programType ?? null,
      },
    });
  }

  async deleteMacrocycleDashboard(program: string): Promise<void> {
    await this.prisma.macrocycleDashboard.deleteMany({
      where: { userId: this.userId, program },
    });
  }
}
