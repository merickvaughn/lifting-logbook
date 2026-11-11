import { NotFoundException } from '@nestjs/common';
import {
  CustomProgramResponse,
  CustomProgramSummaryResponse,
  CustomProgramSpecRow,
  isLiftProgressionType,
} from '@lifting-logbook/types';
import { PrismaExecutor, runInteractive } from '../adapters/prisma/prisma-tx.util';

type ProgressionColumns = { progression: string | null; repsLow: number | null };

/** The natural key of a spec row, `@@unique([programId, week, offset, lift, order])`. */
const specKey = (s: { week: number; offset: number; lift: string; order: number }): string =>
  `${s.week}|${s.offset}|${s.lift}|${s.order}`;

/**
 * The progression columns as written (#1210). A field the row leaves out keeps the stored
 * row's value, and null clears it, so a client that doesn't send `progression` (an older web
 * bundle, during a deploy) can't undo the `amrap_gated` backfill. With no stored row, a field
 * left out is stored as null.
 */
function progressionColumns(s: CustomProgramSpecRow, stored?: ProgressionColumns): ProgressionColumns {
  const sent = s as { progression?: string | null; repsLow?: number | null };
  return {
    progression: sent.progression === undefined ? stored?.progression ?? null : sent.progression,
    repsLow: sent.repsLow === undefined ? stored?.repsLow ?? null : sent.repsLow,
  };
}

function toSpecRow(s: {
  week: number;
  offset: number;
  lift: string;
  increment: number;
  order: number;
  sets: number;
  reps: number;
  amrap: boolean;
  warmUpPct: string;
  wtDecrementPct: number;
  activation: string;
  weekType: string | null;
  progression: string | null;
  repsLow: number | null;
}): CustomProgramSpecRow {
  return {
    week: s.week,
    offset: s.offset,
    lift: s.lift,
    increment: s.increment,
    order: s.order,
    sets: s.sets,
    reps: s.reps,
    amrap: s.amrap,
    warmUpPct: s.warmUpPct,
    wtDecrementPct: s.wtDecrementPct,
    activation: s.activation,
    ...(s.weekType !== null && { weekType: s.weekType }),
    ...(isLiftProgressionType(s.progression) && { progression: s.progression }),
    ...(s.repsLow !== null && { repsLow: s.repsLow }),
  };
}

export class CustomProgramsRepository {
  constructor(
    private readonly prisma: PrismaExecutor,
    private readonly userId: string,
  ) {}

  async list(): Promise<CustomProgramSummaryResponse[]> {
    const rows = await this.prisma.customProgram.findMany({
      where: { userId: this.userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      baseTemplate: r.baseTemplate,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async get(id: string): Promise<CustomProgramResponse> {
    const row = await this.prisma.customProgram.findFirst({
      where: { id, userId: this.userId },
      include: { specs: { orderBy: [{ week: 'asc' }, { order: 'asc' }] } },
    });
    if (!row) throw new NotFoundException(`Custom program ${id} not found`);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      baseTemplate: row.baseTemplate,
      createdAt: row.createdAt.toISOString(),
      specs: row.specs.map(toSpecRow),
    };
  }

  async create(data: {
    name: string;
    description?: string;
    baseTemplate?: string;
    specs: CustomProgramSpecRow[];
  }): Promise<CustomProgramResponse> {
    const row = await this.prisma.customProgram.create({
      data: {
        userId: this.userId,
        name: data.name,
        description: data.description ?? null,
        baseTemplate: data.baseTemplate ?? null,
        specs: {
          create: data.specs.map((s) => ({
            week: s.week,
            offset: s.offset,
            lift: s.lift,
            increment: s.increment,
            order: s.order,
            sets: s.sets,
            reps: s.reps,
            amrap: s.amrap,
            warmUpPct: s.warmUpPct,
            wtDecrementPct: s.wtDecrementPct,
            activation: s.activation,
            weekType: s.weekType ?? null,
            ...progressionColumns(s),
          })),
        },
      },
      include: { specs: { orderBy: [{ week: 'asc' }, { order: 'asc' }] } },
    });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      baseTemplate: row.baseTemplate,
      createdAt: row.createdAt.toISOString(),
      specs: row.specs.map(toSpecRow),
    };
  }

  async update(
    id: string,
    data: { name?: string; description?: string; specs?: CustomProgramSpecRow[] },
  ): Promise<CustomProgramResponse> {
    const specPayload = (stored: Map<string, ProgressionColumns>) => data.specs !== undefined
      ? {
          deleteMany: {},
          create: data.specs.map((s) => ({
            week: s.week,
            offset: s.offset,
            lift: s.lift,
            increment: s.increment,
            order: s.order,
            sets: s.sets,
            reps: s.reps,
            amrap: s.amrap,
            warmUpPct: s.warmUpPct,
            wtDecrementPct: s.wtDecrementPct,
            activation: s.activation,
            weekType: s.weekType ?? null,
            ...progressionColumns(s, stored.get(specKey(s))),
          })),
        }
      : undefined;

    const row = await runInteractive(this.prisma, async (tx) => {
      const existing = await tx.customProgram.findFirst({
        where: { id, userId: this.userId },
      });
      if (!existing) throw new NotFoundException(`Custom program ${id} not found`);
      const storedSpecs = data.specs === undefined
        ? []
        : await tx.customProgramSpec.findMany({
            where: { programId: id },
            select: { week: true, offset: true, lift: true, order: true, progression: true, repsLow: true },
          });
      const stored = new Map(storedSpecs.map((s) => [specKey(s), { progression: s.progression, repsLow: s.repsLow }]));
      const specs = specPayload(stored);
      return tx.customProgram.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description ?? null }),
          ...(specs !== undefined && { specs }),
        },
        include: { specs: { orderBy: [{ week: 'asc' }, { order: 'asc' }] } },
      });
    });

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      baseTemplate: row.baseTemplate,
      createdAt: row.createdAt.toISOString(),
      specs: row.specs.map(toSpecRow),
    };
  }

  async delete(id: string): Promise<void> {
    const result = await this.prisma.customProgram.deleteMany({
      where: { id, userId: this.userId },
    });
    if (result.count === 0) throw new NotFoundException(`Custom program ${id} not found`);
  }
}
