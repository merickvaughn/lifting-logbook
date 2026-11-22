import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { isSameData, parseIsoDate, toIsoDate } from '@lifting-logbook/core';
import { SupplementChange, SupplementDayType, SupplementItem } from '@lifting-logbook/types';
import {
  ISupplementRepository,
  NewSupplementChange,
  SupplementChangePage,
  SupplementState,
  SupplementWritePlan,
} from '../../ports/ISupplementRepository';
import { SupplementWriteConflictError } from '../../ports/errors';
import { PrismaExecutor, canStartTransaction, runInteractive } from './prisma-tx.util';
import { parseChange, parseIngredients, parseLinks, parseReference, parseSlot, parseStatus, toJson } from './supplement-payload';

const itemInclude = {
  doses: { orderBy: { position: 'asc' } },
  parts: { orderBy: { position: 'asc' } },
} satisfies Prisma.SupplementItemInclude;
type ItemRow = Prisma.SupplementItemGetPayload<{ include: typeof itemInclude }>;

/**
 * The seed of the write lock's key, `hashtextextended(userId, 1374)`, so it's a different lock
 * from another feature's on the same user (see MACROCYCLE_LOCK_NAMESPACE). Arbitrary, but fixed.
 */
export const SUPPLEMENT_LOCK_NAMESPACE = 1374;

/**
 * How long a write waits for the user's write lock before it's a `supplement-stale` 409. Well
 * inside the request transaction's 15 s (`DEFAULT_RLS_TX_TIMEOUT_MS`), so a write stuck behind a
 * slow holder gets the 409 ADR-046 promises, not Prisma's transaction timeout as a 500.
 */
export const SUPPLEMENT_LOCK_WAIT_MS = 5_000;

/** Postgres's `lock_not_available`, raised when a lock wait reaches `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';

const isLockTimeout = (err: unknown) =>
  err instanceof PrismaClientKnownRequestError && (err.meta?.code === LOCK_NOT_AVAILABLE || err.message.includes(LOCK_NOT_AVAILABLE));

const tracer = trace.getTracer('prisma-supplement-repository');

// The slot and status columns carry CHECK constraints (migration 20261120000000_add_supplements),
// so the parsers below only throw on a row the database shouldn't hold.
function toItem(row: ItemRow): SupplementItem {
  return {
    id: row.id,
    name: row.name,
    keyCompound: row.keyCompound,
    timing: row.timing,
    shortNote: row.shortNote,
    longNote: row.longNote,
    status: parseStatus(row.status),
    unverified: row.unverified,
    links: parseLinks(row.links),
    category: row.category,
    typicalRange: row.typicalRange,
    ingredients: parseIngredients(row.ingredients),
    ...(row.catalogKey === null ? {} : { catalogKey: row.catalogKey }),
    ...(row.reference === null ? {} : { reference: parseReference(row.reference) }),
    ...(row.isMix
      ? { parts: row.parts.map((p) => ({ itemId: p.partItemId, name: p.name, ingredients: parseIngredients(p.ingredients) })) }
      : {}),
    doses: row.doses.map((d) => ({ slot: parseSlot(d.slot), amount: d.amount, servings: d.servings, dayTypes: d.dayTypes })),
  };
}

const toChange = (row: { type: string; date: Date; seq: number; payload: Prisma.JsonValue }): SupplementChange =>
  parseChange({ ...row, date: toIsoDate(row.date) });

const isUniqueViolation = (err: unknown) => err instanceof PrismaClientKnownRequestError && err.code === 'P2002';

export class PrismaSupplementRepository implements ISupplementRepository {
  constructor(
    private readonly prisma: PrismaExecutor,
    private readonly userId: string,
    private readonly lockWaitMs: number = SUPPLEMENT_LOCK_WAIT_MS,
  ) {}

  async load(): Promise<SupplementState> {
    return this.loadWith(this.prisma);
  }

  async changes(page: SupplementChangePage): Promise<SupplementChange[]> {
    const rows = await this.prisma.supplementChange.findMany({
      where: { userId: this.userId, ...(page.beforeSeq === undefined ? {} : { seq: { lt: page.beforeSeq } }) },
      orderBy: { seq: 'desc' },
      take: page.limit,
    });
    return rows.reverse().map(toChange);
  }

  async changesThrough(date: string): Promise<SupplementChange[]> {
    const rows = await this.prisma.supplementChange.findMany({
      where: { userId: this.userId, date: { lte: parseIsoDate(date) } },
      orderBy: { seq: 'asc' },
    });
    return rows.map(toChange);
  }

  async firstChangeDate(): Promise<string | null> {
    const first = await this.prisma.supplementChange.aggregate({ where: { userId: this.userId }, _min: { date: true } });
    return first._min.date === null ? null : toIsoDate(first._min.date);
  }

  async lastRemoved(itemId: string): Promise<SupplementItem | undefined> {
    const row = await this.prisma.supplementChange.findFirst({
      where: { userId: this.userId, type: 'removed', payload: { path: ['item', 'id'], equals: itemId } },
      orderBy: { seq: 'desc' },
    });
    if (row === null) return undefined;
    const change = toChange(row);
    return change.type === 'removed' ? change.item : undefined;
  }

  async write(plan: SupplementWritePlan): Promise<SupplementState> {
    try {
      return await runInteractive(this.prisma, async (tx) => {
        await this.lock(tx);
        const state = await this.loadWith(tx);
        const before = structuredClone(state);
        const changes = await plan(state);
        await this.save(tx, before, state, changes);
        return { ...state, removed: [], nextSeq: state.nextSeq + changes.length, lastChangeDate: changes[0]?.date ?? state.lastChangeDate };
      });
    } catch (err) {
      // With the lock, only a writer that skips it can collide with this one; whichever key it
      // hit, the transaction rolls back and nothing is stored.
      if (isUniqueViolation(err)) throw new SupplementWriteConflictError();
      throw err;
    }
  }

  /**
   * Waits for the user's supplement write lock, held to the end of the transaction: the
   * request's, which RlsInterceptor opens, or the one `write` opens on the base client. A wait
   * past `lockWaitMs` is a SupplementWriteConflictError, as macrocycle.repository.ts bounds its
   * own. Raw SQL isn't auto-traced (ADR-024), hence the span.
   */
  private async lock(tx: PrismaExecutor): Promise<void> {
    await tracer.startActiveSpan('supplement.lock', async (span) => {
      try {
        span.setAttribute('lock.in_transaction', !canStartTransaction(this.prisma));
        span.setAttribute('lock.wait_ms', this.lockWaitMs);
        const [setting] = await tx.$queryRaw<{ previous: string }[]>`SELECT current_setting('lock_timeout') AS previous`;
        // current_setting always returns a row; restoring a guess could turn the timeout off.
        if (setting === undefined) throw new Error('current_setting(lock_timeout) returned no row');
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${this.lockWaitMs}ms`}, true)`;
        try {
          // void doesn't deserialize, hence the cast to text.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${this.userId}, ${SUPPLEMENT_LOCK_NAMESPACE}))::text`;
        } catch (err) {
          if (!isLockTimeout(err)) throw err;
          // The failed statement aborts the transaction, which the 409 rolls back.
          span.setAttribute('lock.acquired', false);
          throw new SupplementWriteConflictError();
        }
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${setting.previous}, true)`;
        span.setAttribute('lock.acquired', true);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async loadWith(db: PrismaExecutor): Promise<SupplementState> {
    const where = { userId: this.userId };
    const rows = await db.supplementItem.findMany({ where, include: itemInclude, orderBy: { position: 'asc' } });
    const dayTypes = await db.supplementDayType.findMany({ where, orderBy: { position: 'asc' } });
    const settings = await db.userSettings.findUnique({ where });
    const last = await db.supplementChange.aggregate({ where, _max: { seq: true, date: true } });
    return {
      items: rows.filter((r) => r.foldedInto === null).map(toItem),
      folded: rows.flatMap((r) => (r.foldedInto === null ? [] : [{ item: toItem(r), mixId: r.foldedInto }])),
      removed: [],
      dayTypes: dayTypes.map(
        (d): SupplementDayType => ({ id: d.id, name: d.name, ...(d.sessionTime === null ? {} : { sessionTime: d.sessionTime }) }),
      ),
      caffeineCutoff: settings?.supplementCaffeineCutoff ?? null,
      nextSeq: (last._max.seq ?? 0) + 1,
      lastChangeDate: last._max.date === null ? null : toIsoDate(last._max.date),
    };
  }

  /** Writes the parts of `next` that differ from `before`, then appends `changes`. */
  private async save(
    tx: PrismaExecutor,
    before: SupplementState,
    next: SupplementState,
    changes: readonly NewSupplementChange[],
  ): Promise<void> {
    const userId = this.userId;
    const stackChanged = !isSameData([before.items, before.folded], [next.items, next.folded]);
    const dayTypesChanged = !isSameData(before.dayTypes, next.dayTypes);
    const cutoffChanged = before.caffeineCutoff !== next.caffeineCutoff;
    if ((stackChanged || dayTypesChanged || cutoffChanged) && changes.length === 0) {
      throw new Error('A supplement write changed the stack without logging a change');
    }

    if (stackChanged) {
      const stored: { item: SupplementItem; mixId: string | null }[] = [...next.items.map((item) => ({ item, mixId: null })), ...next.folded];
      // Doses and mix parts go with their item (ON DELETE CASCADE).
      await tx.supplementItem.deleteMany({ where: { userId } });
      await tx.supplementItem.createMany({
        data: stored.map(({ item, mixId }, position) => ({
          id: item.id,
          userId,
          name: item.name,
          keyCompound: item.keyCompound,
          timing: item.timing,
          shortNote: item.shortNote,
          longNote: item.longNote,
          status: item.status,
          unverified: item.unverified,
          links: toJson(item.links),
          category: item.category,
          typicalRange: item.typicalRange,
          ingredients: toJson(item.ingredients),
          isMix: item.parts !== undefined,
          foldedInto: mixId,
          position,
          catalogKey: item.catalogKey ?? null,
          reference: item.reference === undefined ? Prisma.DbNull : toJson(item.reference),
        })),
      });
      await tx.supplementDose.createMany({
        data: stored.flatMap(({ item }) => item.doses.map((d, position) => ({ userId, itemId: item.id, position, ...d }))),
      });
      await tx.supplementMixPart.createMany({
        data: stored.flatMap(({ item }) =>
          (item.parts ?? []).map((p, position) => ({
            userId,
            mixId: item.id,
            position,
            partItemId: p.itemId,
            name: p.name,
            ingredients: toJson(p.ingredients),
          })),
        ),
      });
    }
    if (dayTypesChanged) {
      await tx.supplementDayType.deleteMany({ where: { userId } });
      await tx.supplementDayType.createMany({
        data: next.dayTypes.map((d, position) => ({ userId, id: d.id, name: d.name, sessionTime: d.sessionTime ?? null, position })),
      });
    }
    // Only when it changed, so a write can't put back a cutoff it read before another write.
    if (cutoffChanged && next.caffeineCutoff !== null) {
      const supplementCaffeineCutoff = next.caffeineCutoff;
      await tx.userSettings.upsert({
        where: { userId },
        create: { userId, supplementCaffeineCutoff },
        update: { supplementCaffeineCutoff },
      });
    }
    if (changes.length > 0) {
      await tx.supplementChange.createMany({
        data: changes.map(({ date, type, ...payload }, i) => ({
          userId,
          seq: next.nextSeq + i,
          date: parseIsoDate(date),
          type,
          payload: toJson(payload),
        })),
      });
    }
  }
}
