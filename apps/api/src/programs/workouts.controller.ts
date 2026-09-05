import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
} from '@nestjs/common';
import { baseSpecBlockWeeks, blockWeekForProgramWeek, LiftRecord, programLengthWeeks } from '@lifting-logbook/core';
import { WorkoutResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { ProgramNotFoundError, WorkoutNotFoundError } from '../ports/errors';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import {
  applyLiftOverrides,
  isValidWorkoutNum,
  toWorkoutResponse,
  workoutKeyForWorkoutNum,
} from './mappers';

@Controller('programs/:program')
export class WorkoutsController {
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
    const { workout, cycleDashboard, cycleScheduledWorkout, liftingProgramSpec, workoutDateOverride, workoutLiftOverride, workoutSkipOverride } =
      await this.factory.forUser(user);
    const [dashboard, spec] = await Promise.all([
      // fallback-covered-by: apps/api/src/programs/workouts.controller.spec.ts
      cycleDashboard.getCycleDashboard(program).catch((err: unknown) => {
        if (err instanceof ProgramNotFoundError) return { cycleNum: 1 };
        throw err;
      }),
      liftingProgramSpec.getProgramSpec(program),
    ]);
    const [records, overrideDate, liftOverrides, scheduledWorkouts, skippedNums] = await Promise.all([
      // fallback-covered-by: apps/api/src/programs/workouts.controller.spec.ts
      workout
        .getWorkout(program, dashboard.cycleNum, workoutNum)
        .catch((err: unknown) => {
          // Upcoming workouts have no logged records yet — treat as empty.
          if (err instanceof WorkoutNotFoundError) return [] as LiftRecord[];
          throw err;
        }),
      workoutDateOverride.getOverride(program, dashboard.cycleNum, workoutNum),
      workoutLiftOverride.getOverrides(program, dashboard.cycleNum, workoutNum),
      cycleScheduledWorkout.getScheduledWorkouts(program, dashboard.cycleNum),
      // fallback-covered-by: apps/api/src/programs/workouts.controller.spec.ts
      workoutSkipOverride.getSkipsForCycle(program, dashboard.cycleNum).catch((err: unknown) => {
        console.error('[WorkoutsController] getSkipsForCycle failed; defaulting to empty set', err);
        return new Set<number>();
      }),
    ]);
    const scheduledWorkout = scheduledWorkouts.find((s) => s.workoutNum === workoutNum);
    const scheduledDate = scheduledWorkout?.scheduledDate;

    // The scheduled row's weekNum is authoritative for the program week. With no
    // schedule, workoutKeyForWorkoutNum tiles the stored block to the program's
    // canonical length and indexes the global workoutNum into the ordered
    // (week, offset) workout days — so week-2+ workouts of a tiled program
    // (Leangains 12w, 5-3-1 12w) resolve in no-schedule mode too, not only schedule
    // mode (#680 completed by #740). Undefined means workoutNum is past the *full*
    // canonical length. The key's `offset` also feeds the no-schedule detail date
    // below, keeping it aligned with the Cycle Dashboard card (issue #745).
    const workoutKey = workoutKeyForWorkoutNum(spec, workoutNum, program);
    const week = scheduledWorkout?.weekNum ?? workoutKey?.week;
    if (week === undefined) {
      throw new BadRequestException(
        `workoutNum ${workoutNum} exceeds the program's ${programLengthWeeks(program, spec)}-week schedule`,
      );
    }

    // Planned lifts come from the tiled block week: the stored spec is one block,
    // so map the program week (which may exceed blockWeeks) back into the block —
    // via the same helper expandSpecToLength tiles with, so the two never disagree.
    const blockWeek = blockWeekForProgramWeek(week, baseSpecBlockWeeks(spec));
    const specLifts = [...new Set(spec.filter((s) => s.week === blockWeek).map((s) => s.lift))];

    const plannedLifts = applyLiftOverrides(specLifts, liftOverrides);

    // cycleDate is absent only on the ProgramNotFoundError fallback ({ cycleNum: 1 }),
    // where the spec is empty so the workoutNum guard above already 400'd. When
    // present it anchors the no-schedule detail date to the same cycle start the
    // dashboard card derives its date from (issue #745).
    const cycleStartDate = 'cycleDate' in dashboard ? dashboard.cycleDate : undefined;

    // Apply overrides to logged records so removed/replaced lifts don't
    // re-appear via the "append ad-hoc logged lifts" path in toWorkoutResponse.
    // Removed lifts are dropped here; replaced lifts are regrouped inside the
    // mapper (`renamedLifts`) rather than renamed on the records, so each set's
    // `id` is still built from the row as stored (issue #978).
    const replaceMap = new Map(
      liftOverrides
        .filter((o): o is (typeof o) & { replacedBy: string } => o.action === 'replace' && !!o.replacedBy)
        .map((o) => [o.lift, o.replacedBy!]),
    );
    const removedLifts = new Set(liftOverrides.filter((o) => o.action === 'remove').map((o) => o.lift));
    const adjustedRecords = records.filter((r) => !removedLifts.has(r.lift));

    return toWorkoutResponse(program, dashboard.cycleNum, workoutNum, week, adjustedRecords, {
      overrideDate: overrideDate ?? undefined,
      plannedLifts,
      scheduledDate,
      skipped: skippedNums.has(workoutNum),
      cycleStartDate,
      offset: workoutKey?.offset,
      renamedLifts: replaceMap,
    });
  }
}
