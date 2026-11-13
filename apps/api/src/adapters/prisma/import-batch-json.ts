import { MACROCYCLE_STATUSES, MacrocycleStatus } from '@lifting-logbook/types';
import { Prisma } from '@prisma/client';
import { BatchMacrocycles, StatusChoice } from '../../ports/IImportBatchRepository';

type JsonObject = Prisma.JsonObject;

const isObject = (value: Prisma.JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStatus = (value: Prisma.JsonValue | undefined): value is MacrocycleStatus =>
  typeof value === 'string' && (MACROCYCLE_STATUSES as readonly string[]).includes(value);

const ids = (value: Prisma.JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/** A status choice, or null when any part of it is unreadable. */
function statusChoice(value: Prisma.JsonValue): StatusChoice | null {
  if (!isObject(value)) return null;
  const { id, chose, before } = value;
  if (typeof id !== 'string' || !isStatus(chose) || !isObject(before) || typeof before['statusChosen'] !== 'boolean') return null;
  const status = before['status'];
  return { id, chose, before: { ...(isStatus(status) ? { status } : {}), statusChosen: before['statusChosen'] } };
}

/** `macrocycles` as the column stores it, which {@link parseBatchMacrocycles} reads back. */
export function batchMacrocyclesJson({ created, extended, chosen }: BatchMacrocycles): Prisma.InputJsonObject {
  return {
    created,
    extended,
    chosen: chosen.map(({ id, chose, before }) => ({
      id,
      chose,
      before: before.status ? { status: before.status, statusChosen: before.statusChosen } : { statusChosen: before.statusChosen },
    })),
  };
}

/**
 * The `import_batch.macrocycles` column as `PrismaImportBatchRepository.save` writes it (#1255),
 * or null for a batch without one. An unreadable entry is dropped rather than failing the read,
 * and an unreadable column reads as null. Either way undo still recomputes the batch's
 * `imported` macrocycles, found through its set keys' numbers, so nothing is left stale; what's
 * lost is only releasing a status the batch chose.
 */
export function parseBatchMacrocycles(value: Prisma.JsonValue): BatchMacrocycles | null {
  if (!isObject(value)) return null;
  const { created, extended, chosen } = value;
  return {
    created: ids(created),
    extended: ids(extended),
    chosen: Array.isArray(chosen) ? chosen.flatMap((c) => statusChoice(c) ?? []) : [],
  };
}
