import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  BadRequestException,
} from '@nestjs/common';
import {
  LiftRecord,
  liftRecordNaturalKey,
  nonCycleReference,
  withModifications,
  withOccurrence,
} from '@lifting-logbook/core';
import {
  LiftRecordResponse,
  MACROCYCLE_ID_HEADER,
  NON_CYCLE_PROGRAM,
  NonCycleReferenceResponse,
  NonCycleWorkoutResponse,
} from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { assertSetModifications, modificationNamesFor } from '../lifts/lift-modification.util';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CreateNonCycleWorkoutDto } from './create-lift-record.dto';
import { toLiftRecordResponse } from './mappers';
import { checkMacrocycleId, forgetNonCycleBatchKeys, lockForRenumbering } from './macrocycle-history.util';
import {
  NON_CYCLE_MACROCYCLE_NUM,
  ensureNonCycleRow,
  latestNonCycleDay,
  nextNonCycleWorkoutNum,
  nonCycleDate,
  nonCycleRecords,
  nonCycleRow,
  nonCycleWorkout,
} from './non-cycle.util';

/**
 * Non-cycle workouts (proposal 2026-11-06, decision 23, #1184): training outside any program,
 * like a session on vacation. Starting one takes its number; later sets and edits go through
 * the lift-record routes under the reserved program, which `ReservedProgramGuard` lets through.
 * Logs carry counts only, never lifts or notes.
 */
@Controller('non-cycle-workouts')
export class NonCycleWorkoutsController {
  private readonly logger = new Logger(NonCycleWorkoutsController.name);

  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  /** Every non-cycle set, newest workout first, for History whichever program is active. */
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<LiftRecordResponse[]> {
    const repos = await this.factory.forUser(user);
    const records = (await nonCycleRecords(repos)).sort(
      (a, b) => b.date.getTime() - a.date.getTime() || b.workoutNum - a.workoutNum || a.setNum - b.setNum,
    );
    const names = await modificationNamesFor(repos, records);
    return records.map((r) => toLiftRecordResponse(r, names));
  }

  @Get(':workoutNum')
  async get(
    @Param('workoutNum', ParseIntPipe) workoutNum: number,
    @CurrentUser() user: AuthUser,
  ): Promise<NonCycleWorkoutResponse> {
    const repos = await this.factory.forUser(user);
    const records = await nonCycleWorkout(repos, workoutNum);
    const row = await nonCycleRow(repos);
    const names = await modificationNamesFor(repos, records);
    return {
      workoutNum,
      date: records[0].date.toISOString().slice(0, 10),
      macrocycleId: row.id,
      records: records.map((r) => toLiftRecordResponse(r, names)),
    };
  }

  /**
   * Starts a workout with its first set, taking the next number under the macrocycle lock held
   * exclusively, as an import does (decision 13), so two on one date stay separate. The
   * non-cycle macrocycle's row is created on first use. No id travels with it, as with
   * starting any macrocycle.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateNonCycleWorkoutDto, @CurrentUser() user: AuthUser): Promise<NonCycleWorkoutResponse> {
    const date = nonCycleDate(body.date);
    const repos = await this.factory.forUser(user);
    await lockForRenumbering(repos);
    const modificationNames = await assertSetModifications(repos, body.lift, body.modifications ?? []);
    const row = await ensureNonCycleRow(repos, date);
    const workoutNum = await nextNonCycleWorkoutNum(repos);
    const record: LiftRecord = {
      program: NON_CYCLE_PROGRAM,
      macrocycleNum: NON_CYCLE_MACROCYCLE_NUM,
      workoutNum,
      date,
      lift: body.lift,
      ...withOccurrence(body.occurrence),
      setNum: body.setNum,
      weight: body.weight,
      reps: body.reps,
      notes: body.notes ?? '',
      ...withModifications(body.modifications),
    };
    await repos.liftRecord.appendLiftRecords(NON_CYCLE_PROGRAM, [record]);
    this.logger.log({ sets: 1 }, 'Started a non-cycle workout');
    return {
      workoutNum,
      date: date.toISOString().slice(0, 10),
      macrocycleId: row.id,
      records: [toLiftRecordResponse(record, modificationNames)],
    };
  }

  /** Deletes a whole workout. The non-cycle macrocycle's row stays, for the next one. */
  @Delete(':workoutNum')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('workoutNum', ParseIntPipe) workoutNum: number,
    @CurrentUser() user: AuthUser,
    @Headers(MACROCYCLE_ID_HEADER) macrocycleId?: string,
  ): Promise<void> {
    const repos = await this.factory.forUser(user);
    await checkMacrocycleId(repos, NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM, macrocycleId, 'DELETE non-cycle-workouts/:workoutNum');
    const records = await nonCycleWorkout(repos, workoutNum);
    const keys = records.map(liftRecordNaturalKey);
    const deleted = await repos.liftRecord.deleteLiftRecordsByNaturalKeys(NON_CYCLE_PROGRAM, keys);
    const batches = await forgetNonCycleBatchKeys(repos, keys);
    this.logger.log({ sets: deleted, batches }, 'Deleted a non-cycle workout');
  }
}

/**
 * The reference a non-cycle workout shows beside a lift (decision 23): its training max in the
 * active program `:program`, and the reps last performed at the previous max, under any
 * program. On a `:program` route, so the reserved id can't be asked for.
 */
@Controller('programs/:program')
export class NonCycleReferenceController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  @Get('non-cycle-reference')
  async reference(
    @Param('program') program: string,
    @Query('lift') lift: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<NonCycleReferenceResponse> {
    const name = lift?.trim();
    if (!name || name.length > 100) throw new BadRequestException('lift is required, up to 100 characters');
    const repos = await this.factory.forUser(user);
    const [trainingMaxes, history, sets] = await Promise.all([
      repos.trainingMax.getTrainingMaxes(program),
      repos.trainingMaxHistory.getHistory(program, { lift: name }),
      // Sets dated up to the latest a non-cycle set can be.
      repos.liftRecord.getRecordsForLifts([name], latestNonCycleDay()),
    ]);
    return { lift: name, reference: nonCycleReference({ lift: name, trainingMaxes, history, sets }) };
  }
}
