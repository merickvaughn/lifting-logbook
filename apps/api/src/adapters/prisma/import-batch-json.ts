import { MACROCYCLE_STATUSES, MacrocycleStatus } from '@lifting-logbook/types';
import { Prisma } from '@prisma/client';
import { BatchMacrocycles, ContinuedRun, StatusChoice } from '../../ports/IImportBatchRepository';

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

const isString = (value: Prisma.JsonValue | undefined): value is string => typeof value === 'string';
const isStringOrNull = (value: Prisma.JsonValue | undefined): value is string | null => value === null || isString(value);

/** A continued run (#1180), or null when any part of it is unreadable. */
function continuedRun(value: Prisma.JsonValue | undefined): ContinuedRun | null {
  if (!isObject(value)) return null;
  const { id, ended, dashboard, activeProgram } = value;
  if (!isString(id) || !isStringOrNull(activeProgram)) return null;
  let endedRun: ContinuedRun['ended'] = null;
  if (ended !== null) {
    if (!isObject(ended) || !isString(ended['id']) || !isStringOrNull(ended['endDate']) || !isStatus(ended['status'])) return null;
    endedRun = { id: ended['id'], endDate: ended['endDate'], status: ended['status'] };
  }
  let before: ContinuedRun['dashboard'] = null;
  if (dashboard !== null) {
    if (!isObject(dashboard)) return null;
    const { macrocycleUnit, macrocycleDate, sheetName, macrocycleStartWeekday, programType } = dashboard;
    if (![macrocycleUnit, macrocycleDate, sheetName, macrocycleStartWeekday].every(isString) || !isStringOrNull(programType)) {
      return null;
    }
    before = {
      macrocycleUnit: macrocycleUnit as string,
      macrocycleDate: macrocycleDate as string,
      sheetName: sheetName as string,
      macrocycleStartWeekday: macrocycleStartWeekday as string,
      programType,
    };
  }
  return { id, ended: endedRun, dashboard: before, activeProgram };
}

/** `macrocycles` as the column stores it, which {@link parseBatchMacrocycles} reads back. */
export function batchMacrocyclesJson({ created, extended, chosen, continued }: BatchMacrocycles): Prisma.InputJsonObject {
  return {
    created,
    extended,
    chosen: chosen.map(({ id, chose, before }) => ({
      id,
      chose,
      before: before.status ? { status: before.status, statusChosen: before.statusChosen } : { statusChosen: before.statusChosen },
    })),
    ...(continued ? { continued: { ...continued } } : {}),
  };
}

/**
 * The `import_batch.macrocycles` column as `PrismaImportBatchRepository.save` writes it (#1255),
 * or null for a batch without one. An unreadable entry is dropped rather than failing the read,
 * and an unreadable column reads as null. Either way undo still recomputes the batch's
 * `imported` macrocycles, found through its set keys' numbers, so nothing is left stale; what's
 * lost is only releasing a status the batch chose. An unreadable continued run (#1180) reads as
 * one whose macrocycle id is unknown, so undo refuses rather than undo half of it.
 */
export function parseBatchMacrocycles(value: Prisma.JsonValue): BatchMacrocycles | null {
  if (!isObject(value)) return null;
  const { created, extended, chosen, continued } = value;
  const run = continued === undefined ? undefined : (continuedRun(continued) ?? UNREADABLE_RUN);
  return {
    created: ids(created),
    extended: ids(extended),
    chosen: Array.isArray(chosen) ? chosen.flatMap((c) => statusChoice(c) ?? []) : [],
    ...(run ? { continued: run } : {}),
  };
}

/** A continued run that couldn't be read: its empty id names no macrocycle. */
const UNREADABLE_RUN: ContinuedRun = { id: '', ended: null, dashboard: null, activeProgram: null };
