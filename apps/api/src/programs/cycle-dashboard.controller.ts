import { Controller, Delete, Get, HttpCode, HttpStatus, Inject, Logger, Param } from '@nestjs/common';
import { CycleDashboardResponse } from '@lifting-logbook/types';
import { weekTypeForDate } from '@lifting-logbook/core';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { buildCycleDashboardResponse, scheduleCoverage } from './mappers';
import { CycleGenerationService } from './cycle-generation.service';

@Controller('programs/:program')
export class CycleDashboardController {
  private readonly logger = new Logger(CycleDashboardController.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly cycleGenerationService: CycleGenerationService,
  ) {}

  @Get('cycles/current')
  async getCurrentCycle(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<CycleDashboardResponse> {
    const { cycleDashboard, cycleScheduledWorkout, liftingProgramSpec, liftRecord, workoutDateOverride, workoutSkipOverride } =
      await this.factory.forUser(user);

    const [dashboard, programSpec] = await Promise.all([
      cycleDashboard.getCycleDashboard(program),
      liftingProgramSpec.getProgramSpec(program),
    ]);
    const currentWeekType = weekTypeForDate(dashboard.cycleDate, programSpec);

    const [scheduledWorkouts, completedWorkoutNums, overrideMap, skippedNums] = await Promise.all([
      cycleScheduledWorkout.getScheduledWorkouts(program, dashboard.cycleNum),
      // Only the workout numbers are needed here; the full records were fetched
      // and reduced to this set before (issue #982).
      liftRecord.getLoggedWorkoutNums(program, dashboard.cycleNum),
      workoutDateOverride.getOverridesForCycle(program, dashboard.cycleNum),
      workoutSkipOverride.getSkipsForCycle(program, dashboard.cycleNum),
    ]);

    const response = buildCycleDashboardResponse(dashboard, currentWeekType, {
      spec: programSpec,
      scheduled: scheduledWorkouts,
      overrides: overrideMap,
      completedWorkoutNums,
      skippedNums,
    });

    // Since #1023 a cycle's scheduled rows are exactly its program's days (ADR-037).
    // Rows past the last day are left off the dashboard, and days with no row are
    // dated spec-relatively. Either marks a cycle scheduled before #1023, or a
    // program whose days changed mid-cycle. The web never links to such a row, so
    // this is the one place that sees it. The log is structured, so how often such
    // cycles are loaded is a plain `| json` count in Loki. It can't name the cycle:
    // finding those is re-dating's job, from the database (#1032).
    if (scheduledWorkouts.length > 0) {
      const { pastLastDay, unscheduledDays } = scheduleCoverage(dashboard.program, programSpec, scheduledWorkouts);
      if (pastLastDay.length > 0 || unscheduledDays > 0) {
        this.logger.warn(
          { program, cycleNum: dashboard.cycleNum, pastLastDay: pastLastDay.length, unscheduledDays },
          'Scheduled workouts do not match the program days (#1023)',
        );
      }
    }
    return response;
  }

  @Delete('cycles/current')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCurrentCycle(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    const repos = await this.factory.forUser(user);
    await this.cycleGenerationService.deleteCurrentCycle(repos, program);
  }
}
