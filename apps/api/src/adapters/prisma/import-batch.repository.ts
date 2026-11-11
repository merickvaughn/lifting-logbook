import { ImportBatch, PrismaClient } from '@prisma/client';
import { ImportPreImage } from '@lifting-logbook/core';
import { ImportKind } from '@lifting-logbook/types';
import { IImportBatchRepository, ImportBatchRecord } from '../../ports/IImportBatchRepository';

export class PrismaImportBatchRepository implements IImportBatchRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async save(batch: ImportBatchRecord): Promise<void> {
    await this.prisma.importBatch.create({
      data: {
        id: batch.id,
        userId: this.userId,
        program: batch.program,
        destination: batch.destination,
        preImage: batch.preImage as object,
      },
    });
  }

  async findById(id: string, userId: string): Promise<ImportBatchRecord | null> {
    const row = await this.prisma.importBatch.findFirst({
      where: { id, userId },
    });
    return row ? toRecord(row) : null;
  }

  async deleteById(id: string, userId: string): Promise<void> {
    await this.prisma.importBatch.deleteMany({ where: { id, userId } });
  }

  async listForProgram(program: string, destination: ImportKind): Promise<ImportBatchRecord[]> {
    const rows = await this.prisma.importBatch.findMany({ where: { userId: this.userId, program, destination } });
    return rows.map(toRecord);
  }

  async listWithKeysOn(program: string, destination: ImportKind, macrocycleNums: readonly number[]): Promise<ImportBatchRecord[]> {
    if (macrocycleNums.length === 0) return [];
    // The key's leading number, as `preImageKeyNumber` reads it; numeric, so a long digit run
    // can't overflow the cast.
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT b."id" FROM "import_batch" b
      WHERE b."userId" = ${this.userId} AND b."program" = ${program} AND b."destination" = ${destination}
        AND EXISTS (
          SELECT 1 FROM jsonb_object_keys(b."preImage") AS k
          WHERE substring(k from '^(?:macrocycle-row:)?([0-9]+)(?::|$)')::numeric = ANY(${[...macrocycleNums]}::numeric[])
        )`;
    if (ids.length === 0) return [];
    const rows = await this.prisma.importBatch.findMany({
      where: { userId: this.userId, id: { in: ids.map((r) => r.id) } },
    });
    return rows.map(toRecord);
  }

  async updatePreImage(id: string, preImage: ImportPreImage): Promise<void> {
    await this.prisma.importBatch.updateMany({ where: { id, userId: this.userId }, data: { preImage: preImage as object } });
  }
}

function toRecord(row: ImportBatch): ImportBatchRecord {
  return {
    id: row.id,
    userId: row.userId,
    program: row.program,
    destination: row.destination as ImportKind,
    preImage: row.preImage as unknown as ImportPreImage,
    createdAt: row.createdAt,
  };
}
