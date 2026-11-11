import { Macrocycle, PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { MacrocycleOrigin, MacrocycleStatus } from '@lifting-logbook/types';
import { trace } from '@opentelemetry/api';
import { MacrocycleNumberConflictError } from '../../ports/errors';
import { IMacrocycleRepository, MacrocycleRow, NewMacrocycle } from '../../ports/IMacrocycleRepository';

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

/** Postgres's `lock_not_available`, raised when a lock wait reaches `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';

function isLockTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const meta = (err as { meta?: { code?: unknown } }).meta;
  return meta?.code === LOCK_NOT_AVAILABLE || err.message.includes(LOCK_NOT_AVAILABLE);
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
          if (!isLockTimeout(err)) throw err;
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

  async delete(program: string, macrocycleNums: readonly number[]): Promise<void> {
    if (macrocycleNums.length === 0) return;
    await this.prisma.macrocycle.deleteMany({
      where: { userId: this.userId, program, macrocycleNum: { in: [...macrocycleNums] } },
    });
  }

  async deleteAllExcept(program: string, keep: readonly number[]): Promise<void> {
    await this.prisma.macrocycle.deleteMany({
      where: { userId: this.userId, program, macrocycleNum: { notIn: [...keep] } },
    });
  }
}
