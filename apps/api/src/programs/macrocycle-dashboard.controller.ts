import { Controller, Delete, Get, HttpCode, HttpStatus, Inject, Logger, Param } from '@nestjs/common';
import { MacrocycleDashboardResponse } from '@lifting-logbook/types';
import { weekTypeForDate } from '@lifting-logbook/core';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { buildMacrocycleDashboardResponse, scheduleCoverage } from './mappers';
import { MacrocycleGenerationService } from './macrocycle-generation.service';

@Controller('programs/:program')
export class MacrocycleDashboardController {
  private readonly logger = new Logger(MacrocycleDashboardController.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly macrocycleGenerationService: MacrocycleGenerationService,
  ) {}

  @Get('macrocycles/current')
  async getCurrentMacrocycle(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<MacrocycleDashboardResponse> {
    const { macrocycleDashboard, macrocycleScheduledWorkout, liftingProgramSpec, liftRecord, workoutDateOverride, workoutSkipOverride } =
      await this.factory.forUser(user);

    const [dashboard, programSpec] = await Promise.all([
      macrocycleDashboard.getMacrocycleDashboard(program),
      liftingProgramSpec.getProgramSpec(program),
    ]);
    const currentWeekType = weekTypeForDate(dashboard.macrocycleDate, programSpec);

    const [scheduledWorkouts, completedWorkoutNums, overrideMap, skippedNums] = await Promise.all([
      macrocycleScheduledWorkout.getScheduledWorkouts(program, dashboard.macrocycleNum),
      // Only the workout numbers are needed here; the full records were fetched
      // and reduced to this set before (issue #982).
      liftRecord.getLoggedWorkoutNums(program, dashboard.macrocycleNum),
      workoutDateOverride.getOverridesForMacrocycle(program, dashboard.macrocycleNum),
      workoutSkipOverride.getSkipsForMacrocycle(program, dashboard.macrocycleNum),
    ]);

    const response = buildMacrocycleDashboardResponse(dashboard, currentWeekType, {
      spec: programSpec,
      scheduled: scheduledWorkouts,
      overrides: overrideMap,
      completedWorkoutNums,
      skippedNums,
    });

    // Since #1023 a macrocycle's scheduled rows are exactly its program's days (ADR-037).
    // Rows past the last day are left off the dashboard, and days with no row are
    // dated spec-relatively. Either marks a macrocycle scheduled before #1023, or a
    // program whose days changed mid-macrocycle. The web never links to such a row, so
    // this is the one place that sees it. The log is structured, so how often such
    // macrocycles are loaded is a plain `| json` count in Loki. It can't name the macrocycle:
    // finding those is re-dating's job, from the database (#1032).
    if (scheduledWorkouts.length > 0) {
      const { pastLastDay, unscheduledDays } = scheduleCoverage(dashboard.program, programSpec, scheduledWorkouts);
      if (pastLastDay.length > 0 || unscheduledDays > 0) {
        this.logger.warn(
          { program, macrocycleNum: dashboard.macrocycleNum, pastLastDay: pastLastDay.length, unscheduledDays },
          'Scheduled workouts do not match the program days (#1023)',
        );
      }
    }
    return response;
  }

  @Delete('macrocycles/current')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCurrentMacrocycle(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    const repos = await this.factory.forUser(user);
    await this.macrocycleGenerationService.deleteCurrentMacrocycle(repos, program);
  }
}
