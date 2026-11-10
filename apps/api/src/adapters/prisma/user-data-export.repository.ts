import { PrismaClient } from '@prisma/client';
import { IUserDataExportRepository, UserDataRows } from '../../ports/IUserDataExportRepository';

function withoutUserId<T extends { userId: string }>(rows: T[]): Omit<T, 'userId'>[] {
  return rows.map(({ userId: _userId, ...row }) => row);
}

export class PrismaUserDataExportRepository implements IUserDataExportRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  // One query at a time: under the RLS interceptor these share one transaction's connection.
  async readAll(): Promise<UserDataRows> {
    const where = { userId: this.userId };
    const [settings = null] = withoutUserId(await this.prisma.userSettings.findMany({ where }));
    return {
      liftRecords: withoutUserId(
        await this.prisma.liftRecord.findMany({
          where,
          orderBy: [
            { program: 'asc' },
            { macrocycleNum: 'asc' },
            { date: 'asc' },
            { workoutNum: 'asc' },
            { lift: 'asc' },
            { occurrence: 'asc' },
            { setNum: 'asc' },
          ],
        }),
      ),
      trainingMaxes: withoutUserId(
        await this.prisma.trainingMax.findMany({ where, orderBy: [{ program: 'asc' }, { lift: 'asc' }] }),
      ),
      strengthGoals: withoutUserId(
        await this.prisma.strengthGoal.findMany({ where, orderBy: [{ program: 'asc' }, { lift: 'asc' }] }),
      ),
      customPrograms: withoutUserId(
        await this.prisma.customProgram.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          include: { specs: { orderBy: [{ week: 'asc' }, { offset: 'asc' }, { order: 'asc' }] } },
        }),
      ),
      customLifts: withoutUserId(await this.prisma.customLift.findMany({ where, orderBy: { name: 'asc' } })),
      userSettings: settings,
      macrocycles: withoutUserId(
        await this.prisma.macrocycle.findMany({ where, orderBy: [{ program: 'asc' }, { startDate: 'asc' }] }),
      ),
      macrocycleDashboards: withoutUserId(await this.prisma.macrocycleDashboard.findMany({ where })),
      macrocycleScheduledWorkouts: withoutUserId(await this.prisma.macrocycleScheduledWorkout.findMany({ where })),
      trainingMaxHistory: withoutUserId(await this.prisma.trainingMaxHistory.findMany({ where })),
      bodyWeights: withoutUserId(await this.prisma.bodyWeight.findMany({ where })),
      workoutDateOverrides: withoutUserId(await this.prisma.workoutDateOverride.findMany({ where })),
      workoutSkipOverrides: withoutUserId(await this.prisma.workoutSkipOverride.findMany({ where })),
      workoutLiftOverrides: withoutUserId(await this.prisma.workoutLiftOverride.findMany({ where })),
      liftMetadata: withoutUserId(await this.prisma.liftMetadata.findMany({ where })),
      liftModifications: withoutUserId(await this.prisma.liftModification.findMany({ where })),
      focusBlocks: withoutUserId(await this.prisma.focusBlock.findMany({ where })),
      focusDayStates: withoutUserId(await this.prisma.focusDayState.findMany({ where })),
    };
  }
}
