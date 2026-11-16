import { createHash } from 'node:crypto';
import {
  LiftRecordExportRow,
  liftRecordExportFileName as coreLiftRecordExportFileName,
  splitLiftRecordsForImport,
} from '@lifting-logbook/core';
import { LiftRecordExportPart, NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { MAX_IMPORT_ROWS } from '../programs/import-file.util';

/** The `macrocycle` columns a status lookup reads. */
export interface MacrocycleStatusRow {
  program: string;
  macrocycleNum: number;
  status: string;
  statusChosen: boolean;
}

/**
 * Each set with its macrocycle's status where the lifter chose it (#1308). Import reads a `Status`
 * cell as chosen (decision 22), so an inferred one is left empty for the rules to suggest again,
 * and stays unlocked. A live run's `in-progress` is never chosen, so it doesn't come back stuck on
 * an imported macrocycle. A non-cycle workout has no status, and a set whose macrocycle has no row
 * gets none.
 */
export function withStatuses<R extends LiftRecordExportRow>(
  records: readonly R[],
  macrocycles: readonly MacrocycleStatusRow[],
): R[] {
  const key = (program: string, macrocycleNum: number) => JSON.stringify([program, macrocycleNum]);
  const statuses = new Map(
    macrocycles.filter((m) => m.statusChosen).map((m) => [key(m.program, m.macrocycleNum), m.status]),
  );
  return records.map((r) => ({
    ...r,
    status: r.program === NON_CYCLE_PROGRAM ? null : (statuses.get(key(r.program, r.macrocycleNum)) ?? null),
  }));
}

/**
 * The files a sets download comes in: under the importer's row limit each, cut between
 * macrocycles, oldest first (decision 22).
 */
export function exportParts<R extends LiftRecordExportRow>(
  records: readonly R[],
  macrocycles: readonly MacrocycleStatusRow[],
  maxRows = MAX_IMPORT_ROWS,
): R[][] {
  return splitLiftRecordsForImport(withStatuses(records, macrocycles), maxRows);
}

const ymd = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Identifies which sets fall in which part. Any set added or removed changes it, since that can
 * move a macrocycle into another part, and a lifter downloading parts one at a time would then
 * miss it. Edits to a set's weight, reps or notes don't move anything, so they don't count.
 */
export function splitFingerprint(parts: readonly (readonly LiftRecordExportRow[])[]): string {
  const identities = parts.map((rows) =>
    rows.map((r) => [r.program, r.macrocycleNum, r.workoutNum, ymd(r.date), r.lift, r.occurrence, r.setNum]),
  );
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex').slice(0, 16);
}

export function describeParts(parts: readonly (readonly LiftRecordExportRow[])[]): LiftRecordExportPart[] {
  return parts.map((rows, i) => {
    const times = rows.map((r) => r.date.getTime());
    return {
      part: i + 1,
      rows: rows.length,
      from: ymd(new Date(Math.min(...times))),
      to: ymd(new Date(Math.max(...times))),
    };
  });
}

/** For `Content-Disposition`. A download in parts names its part. */
export function liftRecordExportFileName(now: Date, part: number, parts: number): string {
  return coreLiftRecordExportFileName(ymd(now), part, parts);
}

/** A `YYYY-MM-DD` query value as UTC midnight, or null when it isn't a real calendar day. */
export function calendarDay(text: string): Date | null {
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || ymd(date) !== text ? null : date;
}
