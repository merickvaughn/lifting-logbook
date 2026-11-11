import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  blockRange,
  blockStatus,
  buildMuscleTargetResolver,
  expandRollovers,
  nextStart,
  parseIsoDate,
  planFocusDay,
  prescribe,
  summarizeBlock,
  withoutStaleLastReps,
  type FocusGroup,
  type MuscleOverride,
} from '@lifting-logbook/core';
import {
  FocusBlock,
  FocusBlockResponse,
  FocusBlockSummaryResponse,
  FocusDayPlanResponse,
  FocusDayState,
  FocusPlanGroupResponse,
  FocusSettingsResponse,
  emptyFocusDayState,
} from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { FocusBlockNotFoundError } from '../ports/errors';
import { IRepositoryFactory } from '../ports/factory';
import { FocusBlockPatch } from '../ports/IFocusRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { ParseProgramPipe } from '../programs/program.pipe';
import {
  CreateFocusBlockDto,
  FocusSettingsDto,
  ReorderFocusBlocksDto,
  UpdateFocusBlockDto,
} from './focus-block.dto';
import { FocusDayStateDto } from './focus-day-state.dto';
import { currentMacrocycleOrFirst } from '../programs/workout-day.util';
import { MACROCYCLE_ID_HEADER } from '@lifting-logbook/types';
import { checkMacrocycleId, lockForMacrocycleWrite } from '../programs/macrocycle-history.util';
import {
  carryEditsToSuccessor,
  loadFocusBlocks,
  loadFocusWorkoutContext,
  parseIsoDateParam,
  parseToday,
  parseWorkoutNum,
  recordFocusSessions,
  toFocusBlockResponse,
} from './focus.util';

/** Focus blocks, their summaries, and the daily focus guide (#1056). */
@Controller('focus')
export class FocusController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  /** Every focus block, highest priority first, with auto-roll successors created as due. */
  @Get('blocks')
  async list(@Query('today') todayParam: string | undefined, @CurrentUser() user: AuthUser): Promise<FocusBlockResponse[]> {
    const today = parseToday(todayParam);
    const blocks = await loadFocusBlocks(await this.factory.forUser(user), today);
    return blocks.map((block) => toFocusBlockResponse(block, today));
  }

  @Post('blocks')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateFocusBlockDto,
    @Query('today') todayParam: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<FocusBlockResponse> {
    const today = parseToday(todayParam);
    parseIsoDateParam('start', dto.start);
    const { focus } = await this.factory.forUser(user);
    const id = randomUUID();
    // Below every block that still matters: ended blocks keep their last priority, which
    // nothing reads again, so they must not push new priorities up forever.
    const priority =
      dto.priority ??
      notEnded(await focus.listBlocks(), today).reduce((max, b) => Math.max(max, b.priority), 0) + 1;
    const created = await focus.createBlock({
      id,
      series: dto.series ?? id,
      area: dto.area,
      period: dto.period,
      align: dto.align,
      start: dto.start,
      selection: dto.selection,
      overlap: dto.overlap,
      progression: dto.progression,
      priority,
      timer: { ...dto.timer },
      onEnd: dto.onEnd,
      nextArea: dto.nextArea,
      pool: dto.pool.map((entry) => ({ ...entry })),
    });
    return toFocusBlockResponse(created, today);
  }

  /**
   * Sets priorities from positions in `ids`, which must list every focus block that is not
   * ended on `today` exactly once. Ended blocks are left alone: priority only orders the
   * blocks a workout can still use, and the ended ones accumulate without bound.
   */
  @Put('blocks/order')
  async reorder(
    @Body() dto: ReorderFocusBlocksDto,
    @Query('today') todayParam: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<FocusBlockResponse[]> {
    const today = parseToday(todayParam);
    const repos = await this.factory.forUser(user);
    const { focus } = repos;
    // Materialized first, so a successor due today is one of the blocks to order.
    const current = new Set(notEnded(await loadFocusBlocks(repos, today), today).map((block) => block.id));
    const listed = new Set(dto.ids);
    if (listed.size !== dto.ids.length || listed.size !== current.size || dto.ids.some((id) => !current.has(id))) {
      throw new BadRequestException('ids must list every focus block that has not ended, exactly once');
    }
    await focus.setPriorities(dto.ids.map((id, index) => ({ id, priority: index + 1 })));
    const blocks = await focus.listBlocks();
    return blocks.map((block) => toFocusBlockResponse(block, today));
  }

  @Patch('blocks/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFocusBlockDto,
    @Query('today') todayParam: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<FocusBlockResponse> {
    const today = parseToday(todayParam);
    if (dto.start !== undefined) parseIsoDateParam('start', dto.start);
    const { focus } = await this.factory.forUser(user);
    const patch: FocusBlockPatch = {};
    if (dto.area !== undefined) patch.area = dto.area;
    if (dto.period !== undefined) patch.period = dto.period;
    if (dto.align !== undefined) patch.align = dto.align;
    if (dto.start !== undefined) patch.start = dto.start;
    if (dto.selection !== undefined) patch.selection = dto.selection;
    if (dto.overlap !== undefined) patch.overlap = dto.overlap;
    if (dto.progression !== undefined) patch.progression = dto.progression;
    if (dto.timer !== undefined) patch.timer = { ...dto.timer };
    if (dto.onEnd !== undefined) patch.onEnd = dto.onEnd;
    if (dto.nextArea !== undefined) patch.nextArea = dto.nextArea;
    if (dto.pool !== undefined) patch.pool = dto.pool.map((entry) => ({ ...entry }));
    const before = await focus.getBlock(id);
    if (before && patch.pool) patch.pool = withoutStaleLastReps(before.pool, patch.pool);
    const updated = await focus.updateBlock(id, patch);
    if (before) await carryEditsToSuccessor(focus, before, updated, today);
    return toFocusBlockResponse(updated, today);
  }

  /**
   * Deletes a focus block. Any predecessor in its series that the block was keeping from
   * auto-rolling is set to prompt, so cancelling a queued block declines the roll rather
   * than letting the next read create a successor in its place — the prototype's Cancel.
   */
  @Delete('blocks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    const { focus } = await this.factory.forUser(user);
    const block = await focus.getBlock(id);
    if (!block) throw new FocusBlockNotFoundError(id);
    const series = (await focus.listBlocks()).filter((other) => other.series === block.series);
    const remaining = series.filter((other) => other.id !== block.id);
    // Ask core's own rule which rolls the block was covering: owed without it, not with it.
    const covered = (predecessor: FocusBlock) =>
      owesRoll(predecessor, remaining) && !owesRoll(predecessor, series);
    for (const predecessor of remaining.filter(covered)) {
      await focus.updateBlock(predecessor.id, { onEnd: 'prompt' });
    }
    await focus.deleteBlock(id);
  }

  /** Sessions, sets, volume and PRs on the block's pool lifts within its date range. */
  @Get('blocks/:id/summary')
  async summary(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<FocusBlockSummaryResponse> {
    const { focus, customLift, liftRecord } = await this.factory.forUser(user);
    const block = await focus.getBlock(id);
    if (!block) throw new FocusBlockNotFoundError(id);
    const range = blockRange(block);

    // Records can store a custom lift by its uuid; summarizeBlock matches by name.
    const poolLifts = new Set(block.pool.map((entry) => entry.lift));
    const customs = (await customLift.list()).filter((lift) => poolLifts.has(lift.name));
    const nameById = new Map(customs.map((lift) => [lift.id, lift.name] as const));
    const records = await liftRecord.getRecordsForLifts(
      [...poolLifts, ...nameById.keys()],
      parseIsoDate(range.end),
    );
    const totals = summarizeBlock(
      records.map((record) => ({ ...record, lift: nameById.get(record.lift) ?? record.lift })),
      block,
    );
    return { blockId: block.id, rangeStart: range.start, rangeEnd: range.end, ...totals };
  }

  @Get('settings')
  async getSettings(@CurrentUser() user: AuthUser): Promise<FocusSettingsResponse> {
    const { focus } = await this.factory.forUser(user);
    return focus.getBudget();
  }

  @Put('settings')
  async putSettings(@Body() dto: FocusSettingsDto, @CurrentUser() user: AuthUser): Promise<FocusSettingsResponse> {
    const { focus } = await this.factory.forUser(user);
    return focus.setBudget({ sets: dto.sets, minutes: dto.minutes });
  }
}

/** A workout's focus plan and its saved focus choices (#1056). */
@Controller('programs/:program/workouts/:workoutNum')
export class FocusWorkoutController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  @Get('focus-state')
  async getState(
    @Param('program', ParseProgramPipe) program: string,
    @Param('workoutNum') workoutNumParam: string,
    @CurrentUser() user: AuthUser,
  ): Promise<FocusDayState> {
    const workoutNum = parseWorkoutNum(workoutNumParam);
    const repos = await this.factory.forUser(user);
    const { macrocycleNum } = await currentMacrocycleOrFirst(repos, program);
    return (await repos.focus.getDayState(program, macrocycleNum, workoutNum)) ?? emptyFocusDayState();
  }

  @Put('focus-state')
  async putState(
    @Param('program', ParseProgramPipe) program: string,
    @Param('workoutNum') workoutNumParam: string,
    @Body() dto: FocusDayStateDto,
    @CurrentUser() user: AuthUser,
    @Headers(MACROCYCLE_ID_HEADER) macrocycleId?: string,
  ): Promise<FocusDayState> {
    const workoutNum = parseWorkoutNum(workoutNumParam);
    const repos = await this.factory.forUser(user);
    // The lock comes before the current number is read, so an import can't renumber between.
    await lockForMacrocycleWrite(repos);
    const current = await currentMacrocycleOrFirst(repos, program);
    const { macrocycleNum } = current;
    // The route has no number; the page's id must still name the current macrocycle. Before the
    // program is initialized there's no macrocycle, so the page has no id to send (#1200).
    if (macrocycleId !== undefined || 'program' in current) {
      await checkMacrocycleId(repos, program, macrocycleNum, macrocycleId, 'PUT focus-state', {
        current: true,
        locked: true,
      });
    }
    return repos.focus.saveDayState(program, macrocycleNum, workoutNum, {
      modes: { ...dto.modes },
      picks: { ...dto.picks },
      trims: { ...dto.trims },
      placement: dto.placement,
      order: dto.order,
      dismissed: dto.dismissed,
    });
  }

  /**
   * The workout's focus work: every focus block active on `today`, highest priority first,
   * each with its selection, overlap response and prescriptions, plus totals against the
   * daily guide and the trim suggestion when over it.
   */
  @Get('focus')
  async plan(
    @Param('program', ParseProgramPipe) program: string,
    @Param('workoutNum') workoutNumParam: string,
    @Query('today') todayParam: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<FocusDayPlanResponse> {
    const today = parseToday(todayParam);
    const workoutNum = parseWorkoutNum(workoutNumParam);
    const repos = await this.factory.forUser(user);
    const context = await loadFocusWorkoutContext(repos, program, workoutNum);
    const [blocks, budget, savedState, metadata] = await Promise.all([
      loadFocusBlocks(repos, today).then((loaded) => recordFocusSessions(repos, loaded, today)),
      repos.focus.getBudget(),
      repos.focus.getDayState(program, context.macrocycleNum, workoutNum),
      // All of the user's rows, as buildMuscleTargetResolver requires: it maps legacy
      // URL-encoded rows onto their real names (#1017).
      repos.liftMetadata.listMetadata(),
    ]);
    const overrides: MuscleOverride[] = metadata.map((meta) => ({ lift: meta.lift, muscleGroups: meta.muscleGroups }));
    const dayState = savedState ?? emptyFocusDayState();
    const plan = planFocusDay({
      blocks,
      plannedLifts: context.plannedLifts,
      // Keeps counting across weeks, so a pool larger than a week's workouts still reaches
      // every lift; an index within the week would repeat (ADR-039).
      rotationIndex: workoutNum - 1,
      dayState,
      budget,
      today,
      resolveMuscles: buildMuscleTargetResolver(overrides),
    });

    return {
      program,
      macrocycleNum: context.macrocycleNum,
      workoutNum,
      today,
      plannedLifts: context.plannedLifts,
      budget,
      dayState,
      groups: plan.groups.map((group) => toGroupResponse(group, today, context.increment)),
      sets: plan.sets,
      seconds: plan.seconds,
      over: plan.over,
      suggestion: plan.suggestion,
    };
  }
}

/** A date after every block's range, so a block not started yet counts as started. */
const AFTER_EVERY_BLOCK = '9999-12-31';

/**
 * True when core's `expandRollovers` gives `predecessor` a successor, among `blocks`. Only
 * whether one is owed matters, so its pool and increment are placeholders.
 */
function owesRoll(predecessor: FocusBlock, blocks: readonly FocusBlock[]): boolean {
  const start = nextStart(predecessor);
  return expandRollovers([predecessor, ...blocks.filter((b) => b.id !== predecessor.id)], AFTER_EVERY_BLOCK, () => [], 0)
    .some((successor) => successor.series === predecessor.series && successor.start === start);
}

function notEnded(blocks: readonly FocusBlock[], today: string): FocusBlock[] {
  return blocks.filter((block) => blockStatus(block, today) !== 'ended');
}

function toGroupResponse(group: FocusGroup, today: string, increment: number): FocusPlanGroupResponse {
  const { block, selection, trimmed } = group;
  return {
    block: toFocusBlockResponse(block, today),
    mode: selection.mode,
    items: selection.items.map((item) => ({
      lift: item.lift,
      sets: item.sets,
      ...(item.reducedFrom !== undefined ? { reducedFrom: item.reducedFrom } : {}),
      ...(item.swappedFrom !== undefined ? { swappedFrom: item.swappedFrom } : {}),
      entry: item.entry,
      prescription: prescribe(block, item.entry, item.sets, increment),
    })),
    skipped: selection.skipped,
    suggestions: selection.suggestions,
    overlap: selection.overlap,
    trimmed,
  };
}
