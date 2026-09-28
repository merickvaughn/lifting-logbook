import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
} from '@nestjs/common';
import {
  LiftRecord,
  applyLiftOverrides,
  programLengthWeeks,
  specRowsForWorkoutDay,
} from '@lifting-logbook/core';
import { WorkoutResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { ProgramNotFoundError, WorkoutNotFoundError } from '../ports/errors';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import {
  isValidWorkoutNum,
  toWorkoutResponse,
  workoutKeyForWorkoutNum,
} from './mappers';

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
        // Through the class logger (Pino), so the line keeps its trace_id.
        this.logger.error(err, 'getSkipsForCycle failed; defaulting to empty set');
        return new Set<number>();
      }),
    ]);
    const scheduledWorkout = scheduledWorkouts.find((s) => s.workoutNum === workoutNum);
    const scheduledDate = scheduledWorkout?.scheduledDate;

    // The workout's day is its (week, offset) key: workoutKeyForWorkoutNum tiles the
    // stored block to the program's canonical length and indexes the global
    // workoutNum into the ordered workout days, so week-2+ workouts of a tiled
    // program (Leangains 12w, 5-3-1 12w) resolve (#680, #740). It is the numbering
    // the Cycle Dashboard card uses, in both modes: a schedule only dates the
    // program's days, so the scheduled row gives this workout its date, never its
    // week (#1023). The key's `offset` picks the day's lifts below and feeds the
    // no-schedule detail date (issues #745, #1014).
    const workoutKey = workoutKeyForWorkoutNum(spec, workoutNum, program);
    // Only a scheduled row past the program's last day has no key, and its own week
    // is then the only one it has. saveScheduledDates writes none since #1023, so it
    // is from a cycle scheduled before that, or a program that lost days mid-cycle.
    // Undefined means workoutNum is past the *full* canonical length.
    const week = workoutKey?.week ?? scheduledWorkout?.weekNum;
    if (week === undefined) {
      throw new BadRequestException(
        `workoutNum ${workoutNum} exceeds the program's ${programLengthWeeks(program, spec)}-week schedule`,
      );
    }

    // Planned lifts are this workout's own day: the block week its program week
    // tiles from, at its key's offset — the helper the web resolves each lift's
    // prescription with and the Cycle Dashboard builds its cards from. Filtering on
    // the week alone listed every day's lifts on every day (issue #1014). A lift
    // the day repeats is still listed once (#1027). A scheduled workout past the
    // program's last day has no key, and so no day to plan; any sets logged
    // against it are still listed.
    if (!workoutKey) {
      // Structured, so it is a plain `| json` query in Loki. It fires only when such a
      // workout is opened directly, since the web never links to one. The cycle
      // dashboard warns once per load for every cycle still carrying such rows.
      this.logger.warn(
        { program, cycleNum: dashboard.cycleNum, workoutNum, week },
        'Scheduled workout has no program day, so it plans no lifts (#1023)',
      );
    }
    const dayRows = workoutKey
      ? specRowsForWorkoutDay(spec, workoutKey.week, workoutKey.offset)
      : [];
    const specLifts = [...new Set(dayRows.map((s) => s.lift))];

    // One pass decides both the plan and where each logged set belongs, so a swap
    // cannot be followed through its chain for one and a single hop for the other.
    // Removed lifts' records are dropped here; replaced lifts' are regrouped inside
    // the mapper (`renamedLifts`) rather than renamed on the records, so each set's
    // `id` is still built from the row as stored (issue #978).
    const { planned, renamed, removed } = applyLiftOverrides(specLifts, liftOverrides);
    const adjustedRecords = records.filter((r) => !removed.has(r.lift));

    // cycleDate is absent only on the ProgramNotFoundError fallback ({ cycleNum: 1 }),
    // where the spec is empty so the workoutNum guard above already 400'd. When
    // present it anchors the no-schedule detail date to the same cycle start the
    // dashboard card derives its date from (issue #745).
    const cycleStartDate = 'cycleDate' in dashboard ? dashboard.cycleDate : undefined;

    return toWorkoutResponse(program, dashboard.cycleNum, workoutNum, week, adjustedRecords, {
      overrideDate: overrideDate ?? undefined,
      plannedLifts: planned,
      scheduledDate,
      skipped: skippedNums.has(workoutNum),
      cycleStartDate,
      // The day's offset, or null: no key means the program has no day for it.
      offset: workoutKey ? workoutKey.offset : null,
      renamedLifts: renamed,
    });
  }
}
