import { MACROCYCLE_STATUSES, MacrocycleStatus } from '@lifting-logbook/types';
import { Prisma } from '@prisma/client';
import { BatchMacrocycles, JoinedFields } from '../../ports/IImportBatchRepository';

type JsonObject = Prisma.JsonObject;

const isObject = (value: Prisma.JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The readable fields of a join's `before` or `wrote`; an unreadable one is left out, so undo leaves it alone. */
function joinedFields(value: Prisma.JsonValue | undefined): JoinedFields {
  if (!isObject(value)) return {};
  const { status, statusChosen, unmatched } = value;
  return {
    ...(typeof status === 'string' && (MACROCYCLE_STATUSES as readonly string[]).includes(status)
      ? { status: status as MacrocycleStatus }
      : {}),
    ...(typeof statusChosen === 'boolean' ? { statusChosen } : {}),
    ...(typeof unmatched === 'boolean' ? { unmatched } : {}),
  };
}

/**
 * The `import_batch.macrocycles` column as `PrismaImportBatchRepository.save` writes it (#1255),
 * or null for a batch without one. An unreadable entry is dropped rather than failing the read,
 * and an unreadable column reads as null. Either way undo still recomputes the batch's
 * `imported` macrocycles, found through its set keys' numbers, so nothing is left stale; what's
 * lost is only putting back a status or flag a join wrote.
 */
export function parseBatchMacrocycles(value: Prisma.JsonValue): BatchMacrocycles | null {
  if (!isObject(value)) return null;
  const { created, extended } = value;
  return {
    created: Array.isArray(created) ? created.filter((id): id is string => typeof id === 'string') : [],
    extended: Array.isArray(extended)
      ? extended.flatMap((entry) =>
          isObject(entry) && typeof entry['id'] === 'string'
            ? [{ id: entry['id'], before: joinedFields(entry['before']), wrote: joinedFields(entry['wrote']) }]
            : [],
        )
      : [],
  };
}
