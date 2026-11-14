import { ImportBatch, PrismaClient } from '@prisma/client';
import { ImportPreImage } from '@lifting-logbook/core';
import { ImportKind } from '@lifting-logbook/types';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BatchMacrocycles,
  IImportBatchRepository,
  ImportBatchRecord,
  KeyNumbers,
  PRE_IMAGE_KEY_NUMBER,
} from '../../ports/IImportBatchRepository';
import { batchMacrocyclesJson, parseBatchMacrocycles } from './import-batch-json';

const tracer = trace.getTracer('prisma-import-batch-repository');

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
        groupId: batch.groupId ?? null,
        // The import's own time, taken under its lock, so undo orders batches as they were written.
        createdAt: batch.createdAt,
        ...(batch.macrocycles ? { macrocycles: batchMacrocyclesJson(batch.macrocycles) } : {}),
      },
    });
  }

  async findById(id: string, userId: string): Promise<ImportBatchRecord | null> {
    const row = await this.prisma.importBatch.findFirst({
      where: { id, userId },
    });
    return row ? toRecord(row) : null;
  }

  async listGroup(groupId: string): Promise<ImportBatchRecord[]> {
    const rows = await this.prisma.importBatch.findMany({
      where: { userId: this.userId, groupId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRecord);
  }

  async deleteById(id: string, userId: string): Promise<void> {
    await this.prisma.importBatch.deleteMany({ where: { id, userId } });
  }

  async listWithKeysOn(program: string, destination: ImportKind, which: KeyNumbers): Promise<ImportBatchRecord[]> {
    if ('on' in which && which.on.length === 0) return [];
    const nums = 'on' in which ? [...which.on] : [...which.except];
    // Raw SQL isn't auto-traced (ADR-024), so the filter gets a span.
    return tracer.startActiveSpan('import_batch.list_with_keys_on', async (span) => {
      try {
        span.setAttribute('import_batch.mode', 'on' in which ? 'on' : 'except');
        span.setAttribute('import_batch.numbers', nums.length);
        // The key's number as `preImageKeyNumber` reads it; numeric, so a long digit run can't
        // overflow the cast. A key with no number matches neither way.
        const rows = await this.prisma.$queryRaw<ImportBatch[]>`
          SELECT b."id", b."userId", b."program", b."destination", b."preImage", b."createdAt", b."groupId", b."macrocycles" FROM "import_batch" b
          WHERE b."userId" = ${this.userId} AND b."program" = ${program} AND b."destination" = ${destination}
            AND EXISTS (
              SELECT 1 FROM jsonb_object_keys(b."preImage") AS k,
                LATERAL (SELECT substring(k from ${PRE_IMAGE_KEY_NUMBER})::numeric AS num) AS key
              WHERE key.num IS NOT NULL
                AND (key.num = ANY(${nums}::numeric[])) = ${'on' in which}
            )`;
        span.setAttribute('import_batch.count', rows.length);
        return rows.map(toRecord);
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async listWithKeys(destination: ImportKind, keys: readonly string[]): Promise<ImportBatchRecord[]> {
    if (keys.length === 0) return [];
    // Raw SQL isn't auto-traced (ADR-024), so the filter gets a span.
    return tracer.startActiveSpan('import_batch.list_with_keys', async (span) => {
      try {
        span.setAttribute('import_batch.keys', keys.length);
        const rows = await this.prisma.$queryRaw<ImportBatch[]>`
          SELECT b."id", b."userId", b."program", b."destination", b."preImage", b."createdAt", b."groupId", b."macrocycles" FROM "import_batch" b
          WHERE b."userId" = ${this.userId} AND b."destination" = ${destination}
            AND EXISTS (SELECT 1 FROM jsonb_object_keys(b."preImage") AS k WHERE k = ANY(${[...keys]}::text[]))`;
        span.setAttribute('import_batch.count', rows.length);
        return rows.map(toRecord);
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async updatePreImages(updates: ReadonlyArray<{ id: string; preImage: ImportPreImage }>): Promise<void> {
    if (updates.length === 0) return;
    const ids = updates.map((u) => u.id);
    const preImages = updates.map((u) => JSON.stringify(u.preImage));
    // One statement rather than one per batch: 50 batches of 400 keys took about 2.4 s one at a
    // time and about 0.1 s together (ADR-042). Raw SQL isn't auto-traced (ADR-024), hence the span.
    await tracer.startActiveSpan('import_batch.update_pre_images', async (span) => {
      try {
        span.setAttribute('import_batch.count', updates.length);
        await this.prisma.$executeRaw`
          UPDATE "import_batch" AS b SET "preImage" = u.pre::jsonb
          FROM unnest(${ids}::text[], ${preImages}::text[]) AS u(id, pre)
          WHERE b."id" = u.id AND b."userId" = ${this.userId}`;
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async listChoosing(macrocycleId: string): Promise<ImportBatchRecord[]> {
    // Raw SQL isn't auto-traced (ADR-024), so the filter gets a span.
    return tracer.startActiveSpan('import_batch.list_choosing', async (span) => {
      try {
        const rows = await this.prisma.$queryRaw<ImportBatch[]>`
          SELECT b."id", b."userId", b."program", b."destination", b."preImage", b."createdAt", b."groupId", b."macrocycles" FROM "import_batch" b
          WHERE b."userId" = ${this.userId}
            AND b."macrocycles"->'chosen' @> ${JSON.stringify([{ id: macrocycleId }])}::jsonb`;
        span.setAttribute('import_batch.count', rows.length);
        return rows.map(toRecord);
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async updateMacrocycles(id: string, macrocycles: BatchMacrocycles): Promise<void> {
    await this.prisma.importBatch.updateMany({
      where: { id, userId: this.userId },
      data: { macrocycles: batchMacrocyclesJson(macrocycles) },
    });
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
    groupId: row.groupId,
    macrocycles: parseBatchMacrocycles(row.macrocycles),
  };
}
