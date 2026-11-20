import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { parseIsoDate, toIsoDate } from '@lifting-logbook/core';
import {
  Ingredient,
  SupplementChange,
  SupplementDayType,
  SupplementItem,
  SupplementSlot,
  SupplementStatus,
} from '@lifting-logbook/types';
import {
  ISupplementRepository,
  NewSupplementChange,
  SupplementState,
} from '../../ports/ISupplementRepository';
import { SupplementWriteConflictError } from '../../ports/errors';
import { PrismaExecutor, runInteractive } from './prisma-tx.util';

const itemInclude = {
  doses: { orderBy: { position: 'asc' } },
  parts: { orderBy: { position: 'asc' } },
} satisfies Prisma.SupplementItemInclude;
type ItemRow = Prisma.SupplementItemGetPayload<{ include: typeof itemInclude }>;

// The DTOs validate ingredients, and the slot and status columns carry CHECK constraints
// (migration 20261120000000_add_supplements), so the casts below only restate those.
const ingredientsOf = (json: Prisma.JsonValue) => json as unknown as Ingredient[];

function toItem(row: ItemRow): SupplementItem {
  return {
    id: row.id,
    name: row.name,
    keyCompound: row.keyCompound,
    timing: row.timing,
    shortNote: row.shortNote,
    longNote: row.longNote,
    status: row.status as SupplementStatus,
    unverified: row.unverified,
    links: row.links,
    ingredients: ingredientsOf(row.ingredients),
    ...(row.isMix
      ? { parts: row.parts.map((p) => ({ itemId: p.partItemId, name: p.name, ingredients: ingredientsOf(p.ingredients) })) }
      : {}),
    doses: row.doses.map((d) => ({
      slot: d.slot as SupplementSlot,
      amount: d.amount,
      servings: d.servings,
      dayTypes: d.dayTypes,
    })),
  };
}

export class PrismaSupplementRepository implements ISupplementRepository {
  constructor(
    private readonly prisma: PrismaExecutor,
    private readonly userId: string,
  ) {}

  async load(): Promise<SupplementState> {
    const where = { userId: this.userId };
    const rows = await this.prisma.supplementItem.findMany({ where, include: itemInclude, orderBy: { position: 'asc' } });
    const dayTypes = await this.prisma.supplementDayType.findMany({ where, orderBy: { position: 'asc' } });
    const settings = await this.prisma.userSettings.findUnique({ where });
    const last = await this.prisma.supplementChange.aggregate({ where, _max: { seq: true } });
    return {
      items: rows.filter((r) => r.foldedInto === null).map(toItem),
      folded: rows.flatMap((r) => (r.foldedInto === null ? [] : [{ item: toItem(r), mixId: r.foldedInto }])),
      dayTypes: dayTypes.map(
        (d): SupplementDayType => ({ id: d.id, name: d.name, ...(d.sessionTime === null ? {} : { sessionTime: d.sessionTime }) }),
      ),
      caffeineCutoff: settings?.supplementCaffeineCutoff ?? null,
      nextSeq: (last._max.seq ?? 0) + 1,
    };
  }

  async changes(): Promise<SupplementChange[]> {
    const rows = await this.prisma.supplementChange.findMany({ where: { userId: this.userId }, orderBy: { seq: 'asc' } });
    // `payload` is the change without date, seq and type, as save() wrote it.
    return rows.map(
      (r) => ({ ...(r.payload as Prisma.JsonObject), type: r.type, date: toIsoDate(r.date), seq: r.seq }) as unknown as SupplementChange,
    );
  }

  async save(next: SupplementState, changes: readonly NewSupplementChange[]): Promise<void> {
    const userId = this.userId;
    const stored = [
      ...next.items.map((item) => ({ item, mixId: null as string | null })),
      ...next.folded,
    ];
    await runInteractive(this.prisma, async (tx) => {
      // Doses and mix parts go with their item (ON DELETE CASCADE).
      await tx.supplementItem.deleteMany({ where: { userId } });
      await tx.supplementDayType.deleteMany({ where: { userId } });
      await tx.supplementDayType.createMany({
        data: next.dayTypes.map((d, position) => ({ userId, id: d.id, name: d.name, sessionTime: d.sessionTime ?? null, position })),
      });
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
          links: item.links,
          ingredients: item.ingredients as unknown as Prisma.InputJsonValue,
          isMix: item.parts !== undefined,
          foldedInto: mixId,
          position,
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
            ingredients: p.ingredients as unknown as Prisma.InputJsonValue,
          })),
        ),
      });
      if (next.caffeineCutoff !== null) {
        const supplementCaffeineCutoff = next.caffeineCutoff;
        await tx.userSettings.upsert({
          where: { userId },
          create: { userId, supplementCaffeineCutoff },
          update: { supplementCaffeineCutoff },
        });
      }
      // Last, so a write that loses the race on `seq` has stored nothing once the transaction
      // rolls back.
      try {
        await tx.supplementChange.createMany({
          data: changes.map(({ date, type, ...payload }, i) => ({
            userId,
            seq: next.nextSeq + i,
            date: parseIsoDate(date),
            type,
            payload: payload as unknown as Prisma.InputJsonValue,
          })),
        });
      } catch (err) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') throw new SupplementWriteConflictError();
        throw err;
      }
    });
  }
}
