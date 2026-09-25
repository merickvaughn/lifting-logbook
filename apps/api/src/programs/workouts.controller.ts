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

    // The scheduled row's weekNum is authoritative for the program week. With no
    // schedule, workoutKeyForWorkoutNum tiles the stored block to the program's
    // canonical length and indexes the global workoutNum into the ordered
    // (week, offset) workout days — so week-2+ workouts of a tiled program
    // (Leangains 12w, 5-3-1 12w) resolve in no-schedule mode too, not only schedule
    // mode (#680 completed by #740). Undefined means workoutNum is past the *full*
    // canonical length. The key's `offset` picks the day's lifts below and feeds the
    // no-schedule detail date, keeping both aligned with the Cycle Dashboard card
    // (issues #745, #1014).
    const workoutKey = workoutKeyForWorkoutNum(spec, workoutNum, program);
    const week = scheduledWorkout?.weekNum ?? workoutKey?.week;
    if (week === undefined) {
      throw new BadRequestException(
        `workoutNum ${workoutNum} exceeds the program's ${programLengthWeeks(program, spec)}-week schedule`,
      );
    }

    // Planned lifts are this workout's own day: the block week its program week
    // tiles from, at its key's offset — the helper the web resolves each lift's
    // prescription with and the Cycle Dashboard builds its cards from. Filtering on
    // the week alone listed every day's lifts on every day (issue #1014). A lift
    // the day repeats is still listed once (#1027). In schedule mode the week comes
    // from the scheduled row and the offset from the key; they agree whenever the
    // schedule runs the program's own number of days a week, which
    // saveScheduledDates assumes but nothing enforces (#1023). A scheduled workout
    // past the program's last day has no key, and so no day to plan.
    if (!workoutKey) {
      // Structured, so #1023's frequency is a plain `| json` query in Loki.
      this.logger.warn(
        { program, cycleNum: dashboard.cycleNum, workoutNum, week },
        'Scheduled workout has no program day, so it plans no lifts (#1023)',
      );
    }
    const dayRows = workoutKey ? specRowsForWorkoutDay(spec, week, workoutKey.offset) : [];
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
