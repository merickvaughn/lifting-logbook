import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { parseIsoDate, toIsoDate } from '@lifting-logbook/core';
import {
  DEFAULT_FOCUS_BUDGET,
  FocusAlign,
  FocusArea,
  FocusBlock,
  FocusBudget,
  FocusDayState,
  FocusOnEnd,
  FocusOverlap,
  FocusPeriod,
  FOCUS_PROGRESSION_TYPES,
  FocusSelection,
} from '@lifting-logbook/types';
import { FocusBlockPatch, IFocusRepository } from '../../ports/IFocusRepository';
import { FocusBlockConflictError, FocusBlockNotFoundError } from '../../ports/errors';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { PrismaExecutor, canStartTransaction, runBatch } from './prisma-tx.util';
import { parseFocusDayState, parseFocusPool, parseFocusTimer } from './focus-json';

const tracer = trace.getTracer('prisma-focus-repository');

interface FocusBlockRow {
  id: string;
  series: string;
  area: string;
  period: string;
  align: string;
  start: Date;
  selection: string;
  overlap: string;
  progression: string;
  priority: number;
  timer: Prisma.JsonValue;
  onEnd: string;
  nextArea: string | null;
  pool: Prisma.JsonValue;
}

// The enum columns carry CHECK constraints (migration 20261025000000_add_focus_work), so a
// row's strings are always members of their unions; the JSON columns are parsed instead.
// `progression` is narrowed with a lookup instead of a cast, and a value outside the vocabulary throws.
function toFocusBlock(row: FocusBlockRow): FocusBlock {
  const progression = FOCUS_PROGRESSION_TYPES.find((type) => type === row.progression);
  if (progression === undefined) {
    throw new Error(`Focus block ${row.id} has an unknown progression: ${row.progression}`);
  }
  return {
    id: row.id,
    series: row.series,
    area: row.area as FocusArea,
    period: row.period as FocusPeriod,
    align: row.align as FocusAlign,
    start: toIsoDate(row.start),
    selection: row.selection as FocusSelection,
    overlap: row.overlap as FocusOverlap,
    progression,
    priority: row.priority,
    timer: parseFocusTimer(row.timer),
    onEnd: row.onEnd as FocusOnEnd,
    nextArea: row.nextArea as FocusArea | null,
    pool: parseFocusPool(row.pool),
  };
}

/** The writable columns of a block (or a patch of one). */
function toColumns(fields: FocusBlockPatch): Prisma.FocusBlockUncheckedUpdateInput {
  const { start, timer, pool, ...rest } = fields;
  return {
    ...rest,
    ...(start !== undefined ? { start: parseIsoDate(start) } : {}),
    // Validated by the DTOs before reaching the repository.
    ...(timer !== undefined ? { timer: timer as unknown as Prisma.InputJsonValue } : {}),
    ...(pool !== undefined ? { pool: pool as unknown as Prisma.InputJsonValue } : {}),
  };
}

export class PrismaFocusRepository implements IFocusRepository {
  constructor(
    private readonly prisma: PrismaExecutor,
    private readonly userId: string,
  ) {}

  async listBlocks(): Promise<FocusBlock[]> {
    const rows = await this.prisma.focusBlock.findMany({
      where: { userId: this.userId },
      orderBy: [{ priority: 'asc' }, { start: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toFocusBlock);
  }

  async getBlock(id: string): Promise<FocusBlock | null> {
    // The PK is `id` alone, so guard on userId: a bare where:{id} would read another
    // user's block wherever RLS is not in force.
    const row = await this.prisma.focusBlock.findFirst({ where: { id, userId: this.userId } });
    return row ? toFocusBlock(row) : null;
  }

  async lockBlocks(ids: readonly string[]): Promise<FocusBlock[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    // Raw SQL isn't auto-traced (ADR-024), hence the manual span. Row locks taken in id order,
    // so two requests locking overlapping sets can't deadlock on each other. They last until
    // the request's transaction (RlsInterceptor) ends; on the base client there is none, and
    // the lock ends with its statement, which `lock.in_transaction` records.
    return tracer.startActiveSpan('focus.lock_blocks', async (span) => {
      try {
        span.setAttribute('lock.in_transaction', !canStartTransaction(this.prisma));
        span.setAttribute('lock.requested', unique.length);
        const locked = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "focus_block"
          WHERE "userId" = ${this.userId} AND "id" IN (${Prisma.join(unique)})
          ORDER BY "id"
          FOR UPDATE`;
        span.setAttribute('lock.acquired', locked.length);
        if (locked.length === 0) return [];
        // A new statement, so under READ COMMITTED it reads what the lock waited for.
        const rows = await this.prisma.focusBlock.findMany({
          where: { userId: this.userId, id: { in: locked.map((row) => row.id) } },
          orderBy: { id: 'asc' },
        });
        return rows.map(toFocusBlock);
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        span.end();
      }
    });
  }

  async createBlock(block: FocusBlock): Promise<FocusBlock> {
    try {
      const row = await this.prisma.focusBlock.create({ data: this.createInput(block) });
      return toFocusBlock(row);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new FocusBlockConflictError(block.series, block.start);
      }
      throw e;
    }
  }

  async createBlocksIfAbsent(blocks: readonly FocusBlock[]): Promise<void> {
    if (blocks.length === 0) return;
    await this.prisma.focusBlock.createMany({
      data: blocks.map((block) => this.createInput(block)),
      skipDuplicates: true,
    });
  }

  async updateBlock(id: string, patch: FocusBlockPatch): Promise<FocusBlock> {
    const owned = await this.getBlock(id);
    if (!owned) throw new FocusBlockNotFoundError(id);
    try {
      const row = await this.prisma.focusBlock.update({ where: { id }, data: toColumns(patch) });
      return toFocusBlock(row);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new FocusBlockConflictError(owned.series, patch.start ?? owned.start);
      }
      throw e;
    }
  }

  async deleteBlock(id: string): Promise<void> {
    const { count } = await this.prisma.focusBlock.deleteMany({ where: { id, userId: this.userId } });
    if (count === 0) throw new FocusBlockNotFoundError(id);
  }

  async setPriorities(priorities: readonly { id: string; priority: number }[]): Promise<void> {
    await runBatch(this.prisma, (db) =>
      priorities.map(({ id, priority }) =>
        db.focusBlock.updateMany({ where: { id, userId: this.userId }, data: { priority } }),
      ),
    );
  }

  async getBudget(): Promise<FocusBudget> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId: this.userId },
      select: { focusBudgetSets: true, focusBudgetMinutes: true },
    });
    return {
      sets: row?.focusBudgetSets ?? DEFAULT_FOCUS_BUDGET.sets,
      minutes: row?.focusBudgetMinutes ?? DEFAULT_FOCUS_BUDGET.minutes,
    };
  }

  async setBudget(budget: FocusBudget): Promise<FocusBudget> {
    const data = { focusBudgetSets: budget.sets, focusBudgetMinutes: budget.minutes };
    const row = await this.prisma.userSettings.upsert({
      where: { userId: this.userId },
      create: { userId: this.userId, ...data },
      update: data,
    });
    return {
      sets: row.focusBudgetSets ?? DEFAULT_FOCUS_BUDGET.sets,
      minutes: row.focusBudgetMinutes ?? DEFAULT_FOCUS_BUDGET.minutes,
    };
  }

  async getDayState(program: string, macrocycleNum: number, workoutNum: number): Promise<FocusDayState | null> {
    const row = await this.prisma.focusDayState.findUnique({
      where: { userId_program_macrocycleNum_workoutNum: { userId: this.userId, program, macrocycleNum, workoutNum } },
    });
    return row ? parseFocusDayState(row.state) : null;
  }

  async saveDayState(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    state: FocusDayState,
  ): Promise<FocusDayState> {
    // Validated by FocusDayStateDto before reaching the repository.
    const json = state as unknown as Prisma.InputJsonValue;
    const row = await this.prisma.focusDayState.upsert({
      where: { userId_program_macrocycleNum_workoutNum: { userId: this.userId, program, macrocycleNum, workoutNum } },
      create: { userId: this.userId, program, macrocycleNum, workoutNum, state: json },
      update: { state: json },
    });
    return parseFocusDayState(row.state);
  }

  private createInput(block: FocusBlock): Prisma.FocusBlockUncheckedCreateInput {
    return {
      id: block.id,
      userId: this.userId,
      series: block.series,
      area: block.area,
      period: block.period,
      align: block.align,
      start: parseIsoDate(block.start),
      selection: block.selection,
      overlap: block.overlap,
      progression: block.progression,
      priority: block.priority,
      timer: block.timer as unknown as Prisma.InputJsonValue,
      onEnd: block.onEnd,
      nextArea: block.nextArea,
      pool: block.pool as unknown as Prisma.InputJsonValue,
    };
  }
}
