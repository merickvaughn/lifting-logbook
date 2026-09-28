import { Controller, Delete, Get, HttpCode, HttpStatus, Inject, Logger, Param } from '@nestjs/common';
import { CycleDashboardResponse } from '@lifting-logbook/types';
import { weekTypeForDate } from '@lifting-logbook/core';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { buildCycleDashboardResponse } from './mappers';
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

    // A scheduled row past the program's last day dates no workout, so the response
    // leaves it out (#1023). Such rows come from cycles scheduled before #1023, or
    // from programs that lost days mid-cycle. The web never links to them, so this
    // is the one place that sees each such cycle. Structured, so they are a plain
    // `| json` query in Loki: the cycles re-dating would repair (#1032).
    const listed = new Set(response.weeks.flatMap((w) => w.workouts.map((ws) => ws.workoutNum)));
    const dropped = scheduledWorkouts.filter((sw) => !listed.has(sw.workoutNum));
    if (dropped.length > 0) {
      this.logger.warn(
        { program, cycleNum: dashboard.cycleNum, dropped: dropped.length, firstDropped: dropped[0]?.workoutNum },
        'Scheduled workouts past the last program day are left off the dashboard (#1023)',
      );
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
