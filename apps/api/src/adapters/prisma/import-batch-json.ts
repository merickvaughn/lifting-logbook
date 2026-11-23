import {
  FOCUS_PLACEMENTS,
  FOCUS_SELECTIONS,
  FocusPlacement,
  FocusSelection,
  LiftOverrideAction,
  MACROCYCLE_ORIGINS,
  MACROCYCLE_STATUSES,
  MacrocycleOrigin,
  MacrocycleStatus,
} from '@lifting-logbook/types';
import { Weekday } from '@lifting-logbook/core';
import { Prisma } from '@prisma/client';
import { BatchMacrocycles, ContinuedRun, RemovedMacrocycle, StatusChoice } from '../../ports/IImportBatchRepository';

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
const isWeekday = (value: Prisma.JsonValue | undefined): value is Weekday =>
  isString(value) && (Object.values(Weekday) as string[]).includes(value);

const isOrigin = (value: Prisma.JsonValue | undefined): value is MacrocycleOrigin =>
  typeof value === 'string' && (MACROCYCLE_ORIGINS as readonly string[]).includes(value);

const isWholeNumber = (value: Prisma.JsonValue | undefined): value is number => typeof value === 'number' && Number.isInteger(value);

/** A scheduled workout of a removed macrocycle, or null when it's unreadable. */
function scheduledWorkout(value: Prisma.JsonValue): RemovedMacrocycle['schedule'][number] | null {
  if (!isObject(value)) return null;
  const { workoutNum, weekNum, scheduledDate } = value;
  return isWholeNumber(workoutNum) && isWholeNumber(weekNum) && isString(scheduledDate) ? { workoutNum, weekNum, scheduledDate } : null;
}

type Removed<K extends keyof RemovedMacrocycle> = RemovedMacrocycle[K][number];

function dateOverride(value: Prisma.JsonValue): Removed<'dateOverrides'> | null {
  if (!isObject(value)) return null;
  const { workoutNum, newDate } = value;
  return isWholeNumber(workoutNum) && isString(newDate) ? { workoutNum, newDate } : null;
}

function skip(value: Prisma.JsonValue): Removed<'skips'> | null {
  if (!isObject(value)) return null;
  const { workoutNum, reason } = value;
  return isWholeNumber(workoutNum) && isStringOrNull(reason) ? { workoutNum, reason } : null;
}

function liftOverride(value: Prisma.JsonValue): Removed<'liftOverrides'>['overrides'][number] | null {
  if (!isObject(value)) return null;
  const { lift, action, replacedBy } = value;
  if (!isString(lift) || !isLiftOverrideAction(action) || !(replacedBy === undefined || isString(replacedBy))) return null;
  return { lift, action, ...(replacedBy !== undefined ? { replacedBy } : {}) };
}

function workoutLiftOverrides(value: Prisma.JsonValue): Removed<'liftOverrides'> | null {
  if (!isObject(value) || !isWholeNumber(value['workoutNum'])) return null;
  const overrides = everyOrNull(value['overrides'], liftOverride);
  return overrides ? { workoutNum: value['workoutNum'], overrides } : null;
}

const isLiftOverrideAction = (value: Prisma.JsonValue | undefined): value is LiftOverrideAction =>
  value === 'add' || value === 'remove' || value === 'replace';

const isStringArray = (value: Prisma.JsonValue | undefined): value is string[] => Array.isArray(value) && value.every(isString);

/** A record of `T`s, or null when it or any of its values is unreadable. */
function recordOf<T extends Prisma.JsonValue>(value: Prisma.JsonValue | undefined, is: (item: Prisma.JsonValue) => item is T): Record<string, T> | null {
  if (!isObject(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, item]) => item !== undefined && is(item)) ? (Object.fromEntries(entries) as Record<string, T>) : null;
}

/** A saved focus day state, read strictly: unlike `parseFocusDayState`, an unreadable field fails it. */
function focusState(value: Prisma.JsonValue): Removed<'focus'> | null {
  if (!isObject(value) || !isWholeNumber(value['workoutNum']) || !isObject(value['state'])) return null;
  const { modes, picks, trims, placement, order, dismissed } = value['state'];
  const modeRecord = recordOf(modes, (item): item is FocusSelection => isString(item) && (FOCUS_SELECTIONS as readonly string[]).includes(item));
  const pickRecord = recordOf(picks, isStringArray);
  const trimRecord = recordOf(trims, isStringArray);
  if (
    !modeRecord ||
    !pickRecord ||
    !trimRecord ||
    !(isString(placement) && (FOCUS_PLACEMENTS as readonly string[]).includes(placement)) ||
    !(order === null || isStringArray(order)) ||
    typeof dismissed !== 'boolean'
  ) {
    return null;
  }
  return {
    workoutNum: value['workoutNum'],
    state: { modes: modeRecord, picks: pickRecord, trims: trimRecord, placement: placement as FocusPlacement, order, dismissed },
  };
}

/** Every item read by `read`, or null when the value isn't an array or any item is unreadable. */
function everyOrNull<T>(value: Prisma.JsonValue | undefined, read: (item: Prisma.JsonValue) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(read);
  return items.every((item): item is T => item !== null) ? items : null;
}

/**
 * A removed macrocycle (#1354), or null when any part of it is unreadable. A batch from before
 * #1359 recorded no overrides or focus day states, and reads with none.
 */
function removedMacrocycle(value: Prisma.JsonValue): RemovedMacrocycle | null {
  if (!isObject(value)) return null;
  const { id, startDate, endDate, status, statusChosen, origin, unmatched, importedThrough, schedule } = value;
  const absentOrEvery = <T>(field: Prisma.JsonValue | undefined, read: (item: Prisma.JsonValue) => T | null): T[] | null =>
    field === undefined ? [] : everyOrNull(field, read);
  const dateOverrides = absentOrEvery(value['dateOverrides'], dateOverride);
  const skips = absentOrEvery(value['skips'], skip);
  const liftOverrides = absentOrEvery(value['liftOverrides'], workoutLiftOverrides);
  const focus = absentOrEvery(value['focus'], focusState);
  if (!dateOverrides || !skips || !liftOverrides || !focus) return null;
  if (
    !isString(id) ||
    !isString(startDate) ||
    !isStringOrNull(endDate) ||
    !isStatus(status) ||
    typeof statusChosen !== 'boolean' ||
    !isOrigin(origin) ||
    typeof unmatched !== 'boolean' ||
    !isStringOrNull(importedThrough) ||
    !Array.isArray(schedule)
  ) {
    return null;
  }
  const workouts = schedule.map(scheduledWorkout);
  if (workouts.some((w) => w === null)) return null;
  return {
    dateOverrides,
    skips,
    liftOverrides,
    focus,
    id,
    startDate,
    endDate,
    status,
    statusChosen,
    origin,
    unmatched,
    importedThrough,
    schedule: workouts.filter((w): w is RemovedMacrocycle['schedule'][number] => w !== null),
  };
}

/** A continued run (#1180), or null when any part of it is unreadable. */
function continuedRun(value: Prisma.JsonValue | undefined): ContinuedRun | null {
  if (!isObject(value)) return null;
  const { id, ended, removed, dashboard, activeProgram } = value;
  if (!isString(id) || !isStringOrNull(activeProgram)) return null;
  const removedRow = removed === undefined ? undefined : removedMacrocycle(removed);
  if (removedRow === null) return null;
  let endedRun: ContinuedRun['ended'] = null;
  if (ended !== null) {
    if (!isObject(ended) || !isString(ended['id']) || !isStringOrNull(ended['endDate']) || !isStatus(ended['status'])) return null;
    endedRun = { id: ended['id'], endDate: ended['endDate'], status: ended['status'] };
  }
  let before: ContinuedRun['dashboard'] = null;
  if (dashboard !== null) {
    if (!isObject(dashboard)) return null;
    const { macrocycleUnit, macrocycleDate, sheetName, macrocycleStartWeekday, programType } = dashboard;
    if (
      !isString(macrocycleUnit) ||
      !isString(macrocycleDate) ||
      !isString(sheetName) ||
      !isWeekday(macrocycleStartWeekday) ||
      !isStringOrNull(programType)
    ) {
      return null;
    }
    before = { macrocycleUnit, macrocycleDate, sheetName, macrocycleStartWeekday, programType };
  }
  return { id, ended: endedRun, ...(removedRow ? { removed: removedRow } : {}), dashboard: before, activeProgram };
}

/** `macrocycles` as the column stores it, which {@link parseBatchMacrocycles} reads back. */
export function batchMacrocyclesJson({ created, extended, chosen, continued, overwrite }: BatchMacrocycles): Prisma.InputJsonObject {
  return {
    created,
    extended,
    chosen: chosen.map(({ id, chose, before }) => ({
      id,
      chose,
      before: before.status ? { status: before.status, statusChosen: before.statusChosen } : { statusChosen: before.statusChosen },
    })),
    ...(continued ? { continued: { ...continued } } : {}),
    ...(overwrite ? { overwrite: { snapshotId: overwrite.snapshotId } } : {}),
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
  const { created, extended, chosen, continued, overwrite } = value;
  const run = continued === undefined ? undefined : (continuedRun(continued) ?? UNREADABLE_RUN);
  return {
    created: ids(created),
    extended: ids(extended),
    chosen: Array.isArray(chosen) ? chosen.flatMap((c) => statusChoice(c) ?? []) : [],
    ...(run ? { continued: run } : {}),
    // An unreadable one names no snapshot, so undo refuses it as one whose backup is gone (#1182).
    ...(overwrite === undefined
      ? {}
      : { overwrite: { snapshotId: isObject(overwrite) && isString(overwrite['snapshotId']) ? overwrite['snapshotId'] : '' } }),
  };
}

/** A continued run that couldn't be read: its empty id names no macrocycle. */
const UNREADABLE_RUN: ContinuedRun = { id: '', ended: null, dashboard: null, activeProgram: null };
