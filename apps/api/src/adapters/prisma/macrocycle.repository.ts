import { Macrocycle, Prisma, PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { MacrocycleOrigin, MacrocycleStatus } from '@lifting-logbook/types';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { MacrocycleNumberConflictError } from '../../ports/errors';
import { IMacrocycleRepository, MacrocycleRow, NewMacrocycle } from '../../ports/IMacrocycleRepository';
import { PrismaExecutor, runInteractive } from './prisma-tx.util';

function toRow(row: Macrocycle): MacrocycleRow {
  return {
    id: row.id,
    program: row.program,
    macrocycleNum: row.macrocycleNum,
    startDate: row.startDate,
    endDate: row.endDate,
    // The table's CHECK constraints hold these to the shared lists.
    status: row.status as MacrocycleStatus,
    statusChosen: row.statusChosen,
    origin: row.origin as MacrocycleOrigin,
    unmatched: row.unmatched,
    importedThrough: row.importedThrough,
  };
}

/**
 * The seed of the lock key's hash, `hashtextextended(userId, 1171)`, so this lock's keys differ
 * from another feature's keys on the same user. Arbitrary, but fixed: #1199's renumbering takes
 * the same key. The 64-bit hash makes two users sharing a key vanishingly unlikely; a 32-bit one
 * would collide within a few tens of thousands of users.
 */
export const MACROCYCLE_LOCK_NAMESPACE = 1171;

/**
 * Postgres's `lock_not_available`, raised when a lock wait reaches `lock_timeout`, and
 * `deadlock_detected`, raised in one of two requests that both hold the lock shared and both
 * ask for it exclusively, as two renumbering starts or deletes can (#1199).
 */
const LOCK_REFUSED = ['55P03', '40P01'];

function isLockRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const meta = (err as { meta?: { code?: unknown } }).meta;
  return LOCK_REFUSED.some((code) => meta?.code === code || err.message.includes(code));
}

const tracer = trace.getTracer('prisma-macrocycle-repository');

export class PrismaMacrocycleRepository implements IMacrocycleRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  // Raw SQL isn't auto-traced (ADR-024), hence the manual spans. The `_xact_` forms release at
  // the end of the request's transaction (RlsInterceptor), so nothing has to unlock.

  /**
   * Whether this repository runs inside a transaction, which the lock needs to last past its
   * own statement. The base client (the system-DB factory) can start transactions, and a
   * transaction client can't, so the spans record `lock.in_transaction` false there.
   */
  private inTransaction(): boolean {
    return typeof (this.prisma as { $transaction?: unknown }).$transaction !== 'function';
  }

  async tryLockShared(): Promise<boolean> {
    return tracer.startActiveSpan('macrocycle.try_lock', async (span) => {
      try {
        span.setAttribute('lock.mode', 'shared');
        span.setAttribute('lock.in_transaction', this.inTransaction());
        const rows = await this.prisma.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${this.userId}, ${MACROCYCLE_LOCK_NAMESPACE})) AS locked`;
        const locked = rows[0]?.locked === true;
        span.setAttribute('lock.acquired', locked);
        return locked;
      } finally {
        span.end();
      }
    });
  }

  async lockExclusive(waitMs: number): Promise<boolean> {
    return tracer.startActiveSpan('macrocycle.lock', async (span) => {
      try {
        span.setAttribute('lock.mode', 'exclusive');
        span.setAttribute('lock.in_transaction', this.inTransaction());
        span.setAttribute('lock.wait_ms', waitMs);
        const settings = await this.prisma.$queryRaw<{ previous: string }[]>`
          SELECT current_setting('lock_timeout') AS previous`;
        await this.prisma.$queryRaw`SELECT set_config('lock_timeout', ${`${waitMs}ms`}, true)`;
        try {
          // void doesn't deserialize, hence the cast.
          await this.prisma.$queryRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${this.userId}, ${MACROCYCLE_LOCK_NAMESPACE}))::text`;
        } catch (err) {
          // The failed statement aborts the transaction, which the caller's 409 rolls back.
          if (!isLockRefused(err)) throw err;
          span.setAttribute('lock.acquired', false);
          return false;
        }
        const previous = settings[0]?.previous;
        // current_setting always returns a row; restoring a guess could turn the timeout off.
        if (previous === undefined) throw new Error('current_setting(lock_timeout) returned no row');
        await this.prisma.$queryRaw`SELECT set_config('lock_timeout', ${previous}, true)`;
        span.setAttribute('lock.acquired', true);
        return true;
      } finally {
        span.end();
      }
    });
  }

  async findById(id: string): Promise<MacrocycleRow | null> {
    const row = await this.prisma.macrocycle.findFirst({ where: { id, userId: this.userId } });
    return row ? toRow(row) : null;
  }

  async list(program: string): Promise<MacrocycleRow[]> {
    const rows = await this.prisma.macrocycle.findMany({
      where: { userId: this.userId, program },
      orderBy: [{ startDate: 'asc' }, { macrocycleNum: 'asc' }],
    });
    return rows.map(toRow);
  }

  async findByNumber(program: string, macrocycleNum: number): Promise<MacrocycleRow | null> {
    const row = await this.prisma.macrocycle.findUnique({
      where: { userId_program_macrocycleNum: { userId: this.userId, program, macrocycleNum } },
    });
    return row ? toRow(row) : null;
  }

  async highestNumber(program: string): Promise<number> {
    const { _max } = await this.prisma.macrocycle.aggregate({
      where: { userId: this.userId, program },
      _max: { macrocycleNum: true },
    });
    return _max.macrocycleNum ?? 0;
  }

  async create(macrocycle: NewMacrocycle): Promise<MacrocycleRow> {
    try {
      const row = await this.prisma.macrocycle.create({
        data: {
          userId: this.userId,
          program: macrocycle.program,
          macrocycleNum: macrocycle.macrocycleNum,
          startDate: macrocycle.startDate,
          endDate: macrocycle.endDate ?? null,
          status: macrocycle.status,
          origin: macrocycle.origin,
        },
      });
      return toRow(row);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new MacrocycleNumberConflictError(macrocycle.program, macrocycle.macrocycleNum);
      }
      throw e;
    }
  }

  async createMany(macrocycles: readonly NewMacrocycle[]): Promise<void> {
    const [first] = macrocycles;
    if (!first) return;
    try {
      await this.prisma.macrocycle.createMany({
        data: macrocycles.map((m) => ({
          userId: this.userId,
          program: m.program,
          macrocycleNum: m.macrocycleNum,
          startDate: m.startDate,
          endDate: m.endDate ?? null,
          status: m.status,
          origin: m.origin,
        })),
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new MacrocycleNumberConflictError(first.program, undefined, { cause: e });
      }
      throw e;
    }
  }

  async ensure(macrocycles: readonly NewMacrocycle[]): Promise<void> {
    if (macrocycles.length === 0) return;
    // ON CONFLICT DO NOTHING: a row a concurrent request just inserted is kept, not a 409.
    await this.prisma.macrocycle.createMany({
      data: macrocycles.map((m) => ({
        userId: this.userId,
        program: m.program,
        macrocycleNum: m.macrocycleNum,
        startDate: m.startDate,
        endDate: m.endDate ?? null,
        status: m.status,
        origin: m.origin,
      })),
      skipDuplicates: true,
    });
  }

  async close(program: string, macrocycleNum: number, end: { endDate: Date; status: MacrocycleStatus }): Promise<void> {
    await this.prisma.macrocycle.updateMany({
      where: { userId: this.userId, program, macrocycleNum },
      data: { endDate: end.endDate, status: end.status },
    });
  }

  async numbersInUse(program: string): Promise<number[]> {
    // Raw SQL isn't auto-traced (ADR-024), so the read gets a span.
    return tracer.startActiveSpan('macrocycle.numbers_in_use', async (span) => {
      try {
        const rows = await this.prisma.$queryRaw<Array<{ num: number }>>`
          ${Prisma.join(
            NUMBERED_TABLES.map(
              (table) => Prisma.sql`
                SELECT "macrocycleNum" AS num FROM ${Prisma.raw(`"${table}"`)}
                WHERE "userId" = ${this.userId} AND "program" = ${program}`,
            ),
            ' UNION ',
          )}
          ORDER BY num`;
        span.setAttribute('macrocycle.count', rows.length);
        return rows.map((r) => r.num);
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async delete(program: string, macrocycleNums: readonly number[]): Promise<void> {
    if (macrocycleNums.length === 0) return;
    const nums = [...macrocycleNums];
    await this.deleteFromEveryTable(program, Prisma.sql`"macrocycleNum" = ANY(${nums}::int[])`, nums.length);
  }

  async deleteAllExcept(program: string, keep: readonly number[]): Promise<void> {
    const kept = [...keep];
    await this.deleteFromEveryTable(program, Prisma.sql`NOT ("macrocycleNum" = ANY(${kept}::int[]))`);
  }

  /** Deletes the program's rows matching `which` from every numbered table, in one span. */
  private async deleteFromEveryTable(program: string, which: Prisma.Sql, count?: number): Promise<void> {
    // Raw SQL isn't auto-traced (ADR-024), so the deletes get a span.
    await tracer.startActiveSpan('macrocycle.delete_numbers', async (span) => {
      try {
        if (count !== undefined) span.setAttribute('macrocycle.count', count);
        let rows = 0;
        await runInteractive(this.prisma, async (db) => {
          for (const table of NUMBERED_TABLES) {
            rows += await db.$executeRaw`
              DELETE FROM ${Prisma.raw(`"${table}"`)}
              WHERE "userId" = ${this.userId} AND "program" = ${program} AND ${which}`;
          }
        });
        span.setAttribute('macrocycle.rows_deleted', rows);
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): Promise<number> {
    if (changes.size === 0) return 0;
    const olds = [...changes.keys()];
    const news = [...changes.values()];
    const temps = news.map((n) => -1 - n);
    // Two passes, since unique keys are checked per row: every moving row first takes -1 - its
    // new number, which no stored row holds, then flips to the new number.
    const rewrite = async (db: PrismaExecutor): Promise<number> => {
      // First, a row on a new number that `changes` doesn't move, in any table, refuses the whole
      // rewrite: it would merge into the macrocycle that moves onto that number, which the unique
      // keys catch only when the rest of the key matches too.
      const [held] = await db.$queryRaw<Array<{ tbl: string; num: number }>>`
        ${Prisma.join(
          NUMBERED_TABLES.map(
            (table) => Prisma.sql`
              (SELECT ${table}::text AS tbl, "macrocycleNum" AS num FROM ${Prisma.raw(`"${table}"`)}
               WHERE "userId" = ${this.userId} AND "program" = ${program}
                 AND "macrocycleNum" = ANY(${news}::int[]) AND NOT ("macrocycleNum" = ANY(${olds}::int[]))
               LIMIT 1)`,
          ),
          ' UNION ALL ',
        )}
        LIMIT 1`;
      if (held) throw new MacrocycleNumberConflictError(program, undefined, { table: held.tbl, heldNumber: held.num });
      let rows = 0;
      for (const table of NUMBERED_TABLES) {
        rows += await db.$executeRaw`
          UPDATE ${Prisma.raw(`"${table}"`)} AS t SET "macrocycleNum" = -1 - m.new_num
          FROM unnest(${olds}::int[], ${news}::int[]) AS m(old_num, new_num)
          WHERE t."userId" = ${this.userId} AND t."program" = ${program} AND t."macrocycleNum" = m.old_num`;
      }
      for (const table of NUMBERED_TABLES) {
        await db.$executeRaw`
          UPDATE ${Prisma.raw(`"${table}"`)} SET "macrocycleNum" = -1 - "macrocycleNum"
          WHERE "userId" = ${this.userId} AND "program" = ${program} AND "macrocycleNum" = ANY(${temps}::int[])`;
      }
      return rows;
    };
    try {
      // The request's transaction makes it all-or-nothing; a bare client needs its own.
      return await runInteractive(this.prisma, rewrite);
    } catch (err) {
      // The unique keys stay the backstop behind the check above.
      if (err instanceof Error && err.message.includes(UNIQUE_VIOLATION)) {
        throw new MacrocycleNumberConflictError(program, undefined, { cause: err });
      }
      throw err;
    }
  }
}

/** Postgres's `unique_violation`, which a raw query's error carries in its message. */
const UNIQUE_VIOLATION = '23505';

/** Every table that holds a macrocycle number (ADR-042). Constants, so safe to splice into SQL. */
export const NUMBERED_TABLES = [
  'lift_record',
  'macrocycle_dashboard',
  'workout_date_override',
  'workout_skip_override',
  'workout_lift_override',
  'focus_day_state',
  'macrocycle_scheduled_workout',
  'macrocycle',
] as const;
