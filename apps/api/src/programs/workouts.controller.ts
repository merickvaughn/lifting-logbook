import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
} from '@nestjs/common';
import { LiftRecord } from '@lifting-logbook/core';
import { WorkoutResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { WorkoutNotFoundError } from '../ports/errors';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { isValidWorkoutNum, toWorkoutResponse } from './mappers';
import { currentMacrocycleOrFirst, resolveWorkoutDay } from './workout-day.util';

@Controller('programs/:program')
export class WorkoutsController {
  private readonly logger = new Logger(WorkoutsController.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Get('workouts/:workoutNum')
  async getWorkout(
    @Param('program') program: string,
    @Param('workoutNum') workoutNumParam: string,
    @CurrentUser() user: AuthUser,
  ): Promise<WorkoutResponse> {
    const workoutNum = Number.parseInt(workoutNumParam, 10);
    if (!isValidWorkoutNum(workoutNum)) {
      throw new BadRequestException('workoutNum must be a positive integer');
    }
    const { workout, macrocycleDashboard, macrocycleScheduledWorkout, liftingProgramSpec, workoutDateOverride, workoutLiftOverride, workoutSkipOverride } =
      await this.factory.forUser(user);
    const [dashboard, spec] = await Promise.all([
      currentMacrocycleOrFirst(macrocycleDashboard, program),
      liftingProgramSpec.getProgramSpec(program),
    ]);
    const [records, overrideDate, liftOverrides, scheduledWorkouts, skippedNums] = await Promise.all([
      // fallback-covered-by: apps/api/src/programs/workouts.controller.spec.ts
      workout
        .getWorkout(program, dashboard.macrocycleNum, workoutNum)
        .catch((err: unknown) => {
          // Upcoming workouts have no logged records yet — treat as empty.
          if (err instanceof WorkoutNotFoundError) return [] as LiftRecord[];
          throw err;
        }),
      workoutDateOverride.getOverride(program, dashboard.macrocycleNum, workoutNum),
      workoutLiftOverride.getOverrides(program, dashboard.macrocycleNum, workoutNum),
      macrocycleScheduledWorkout.getScheduledWorkouts(program, dashboard.macrocycleNum),
      // fallback-covered-by: apps/api/src/programs/workouts.controller.spec.ts
      workoutSkipOverride.getSkipsForMacrocycle(program, dashboard.macrocycleNum).catch((err: unknown) => {
        // Through the class logger (Pino), so the line keeps its trace_id.
        this.logger.error(err, 'getSkipsForMacrocycle failed; defaulting to empty set');
        return new Set<number>();
      }),
    ]);
    const scheduledWorkout = scheduledWorkouts.find((s) => s.workoutNum === workoutNum);
    const scheduledDate = scheduledWorkout?.scheduledDate;

    // The workout's day and planned lifts (see resolveWorkoutDay): shared with the focus
    // plan, so focus overlap is judged against the lifts listed here. The key's `offset`
    // feeds the no-schedule detail date (issues #745, #1014). A scheduled workout past
    // the program's last day has no key, and so no day to plan; any sets logged against
    // it are still listed.
    const { workoutKey, week, planned, renamed, removed } = resolveWorkoutDay(
      program,
      workoutNum,
      spec,
      scheduledWorkouts,
      liftOverrides,
    );
    if (!workoutKey) {
      // Structured, so it is a plain `| json` query in Loki. It fires only when such a
      // workout is opened directly, since the web never links to one. The macrocycle
      // dashboard warns once per load for every macrocycle still carrying such rows.
      this.logger.warn(
        { program, macrocycleNum: dashboard.macrocycleNum, workoutNum, week },
        'Scheduled workout has no program day, so it plans no lifts (#1023)',
      );
    }

    // One pass decides both the plan and where each logged set belongs, so a swap
    // cannot be followed through its chain for one and a single hop for the other.
    // Removed lifts' records are dropped here; replaced lifts' are regrouped inside
    // the mapper (`renamedLifts`) rather than renamed on the records, so each set's
    // `id` is still built from the row as stored (issue #978).
    const adjustedRecords = records.filter((r) => !removed.has(r.lift));

    // macrocycleDate is absent only on the ProgramNotFoundError fallback ({ macrocycleNum: 1 }),
    // where the spec is empty so the workoutNum guard above already 400'd. When
    // present it anchors the no-schedule detail date to the same macrocycle start the
    // dashboard card derives its date from (issue #745).
    const macrocycleStartDate = 'macrocycleDate' in dashboard ? dashboard.macrocycleDate : undefined;

    return toWorkoutResponse(program, dashboard.macrocycleNum, workoutNum, week, adjustedRecords, {
      overrideDate: overrideDate ?? undefined,
      plannedLifts: planned,
      scheduledDate,
      skipped: skippedNums.has(workoutNum),
      macrocycleStartDate,
      // The day's offset, or null: no key means the program has no day for it.
      offset: workoutKey ? workoutKey.offset : null,
      renamedLifts: renamed,
    });
  }
}
