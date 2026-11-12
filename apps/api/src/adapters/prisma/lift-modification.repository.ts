import { PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { ModificationMax } from '@lifting-logbook/core';
import { LiftModification, LiftModificationMaxMode } from '@lifting-logbook/types';
import { runBatch } from './prisma-tx.util';
import {
  CreateLiftModificationInput,
  ILiftModificationRepository,
  UpdateLiftModificationPatch,
} from '../../ports/ILiftModificationRepository';
import { LiftModificationConflictError, LiftModificationNotFoundError } from '../../ports/errors';

interface LiftModificationRow {
  id: string;
  userId: string;
  lift: string;
  name: string;
  description: string;
  maxMode: string;
  archivedAt: Date | null;
  createdAt: Date;
}

export class PrismaLiftModificationRepository implements ILiftModificationRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async list(): Promise<LiftModification[]> {
    const rows = await this.prisma.liftModification.findMany({
      where: { userId: this.userId },
      orderBy: { name: 'asc' },
    });
    return rows.map(toLiftModification);
  }

  async create(input: CreateLiftModificationInput): Promise<LiftModification> {
    const details = { description: input.description ?? '', maxMode: input.maxMode ?? 'none' };
    const archived = await this.prisma.liftModification.findFirst({
      where: { userId: this.userId, lift: input.lift, name: input.name, archivedAt: { not: null } },
    });
    try {
      const row = archived
        ? await this.prisma.liftModification.update({
            where: { id: archived.id },
            data: { ...details, archivedAt: null },
          })
        : await this.prisma.liftModification.create({
            data: { userId: this.userId, lift: input.lift, name: input.name, ...details },
          });
      return toLiftModification(row);
    } catch (e) {
      throw translateWriteError(e, archived?.id ?? '', input.name);
    }
  }

  async update(id: string, patch: UpdateLiftModificationPatch): Promise<LiftModification> {
    // The PK is `id` alone, so guard on userId, as PrismaCustomLiftRepository does.
    const owned = await this.prisma.liftModification.findFirst({
      where: { id, userId: this.userId, archivedAt: null },
    });
    if (!owned) throw new LiftModificationNotFoundError(id);
    try {
      const row = await this.prisma.liftModification.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.maxMode !== undefined ? { maxMode: patch.maxMode } : {}),
        },
      });
      return toLiftModification(row);
    } catch (e) {
      throw translateWriteError(e, id, patch.name ?? owned.name);
    }
  }

  async delete(id: string): Promise<void> {
    const owned = await this.prisma.liftModification.findFirst({ where: { id, userId: this.userId } });
    if (!owned) throw new LiftModificationNotFoundError(id);
    const namedBySet = await this.prisma.liftRecord.findFirst({
      where: { userId: this.userId, modifications: { has: id } },
      select: { id: true },
    });
    const where = { id, userId: this.userId };
    if (!namedBySet) {
      const { count } = await this.prisma.liftModification.deleteMany({ where });
      if (count === 0) throw new LiftModificationNotFoundError(id);
    } else if (!owned.archivedAt) {
      const { count } = await this.prisma.liftModification.updateMany({ where, data: { archivedAt: new Date() } });
      if (count === 0) throw new LiftModificationNotFoundError(id);
    }
  }

  async getMaxes(program: string): Promise<ModificationMax[]> {
    const rows = await this.prisma.liftModificationMax.findMany({
      where: { userId: this.userId, program },
      orderBy: { modificationId: 'asc' },
    });
    return rows.map((r) => ({ modificationId: r.modificationId, weight: r.weight, dateUpdated: r.dateUpdated }));
  }

  async saveMaxes(program: string, maxes: readonly ModificationMax[]): Promise<void> {
    await runBatch(this.prisma, (db) =>
      maxes.map((m) =>
        db.liftModificationMax.upsert({
          where: {
            userId_program_modificationId: { userId: this.userId, program, modificationId: m.modificationId },
          },
          create: {
            userId: this.userId,
            program,
            modificationId: m.modificationId,
            weight: m.weight,
            dateUpdated: m.dateUpdated,
          },
          update: { weight: m.weight, dateUpdated: m.dateUpdated },
        }),
      ),
    );
  }

  async deleteAllMaxes(program: string): Promise<void> {
    await this.prisma.liftModificationMax.deleteMany({ where: { userId: this.userId, program } });
  }
}

/** A row can go between the ownership read and the write, so P2025 is the documented not found. */
function translateWriteError(e: unknown, id: string, name: string): unknown {
  if (e instanceof PrismaClientKnownRequestError) {
    if (e.code === 'P2002') return new LiftModificationConflictError(name);
    if (e.code === 'P2025') return new LiftModificationNotFoundError(id);
  }
  return e;
}

function toLiftModification(row: LiftModificationRow): LiftModification {
  return {
    id: row.id,
    userId: row.userId,
    lift: row.lift,
    name: row.name,
    description: row.description,
    maxMode: row.maxMode as LiftModificationMaxMode,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}
