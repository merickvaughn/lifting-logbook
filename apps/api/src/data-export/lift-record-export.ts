import { LiftRecordExportRow, splitLiftRecordsForImport } from '@lifting-logbook/core';
import { LiftRecordExportPart, NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { MAX_IMPORT_ROWS } from '../programs/import-file.util';

/** The `macrocycle` columns a status lookup reads. */
export interface MacrocycleStatusRow {
  program: string;
  macrocycleNum: number;
  status: string;
}

/**
 * Each set with its macrocycle's stored status (#1308), which import reads back as one the lifter
 * chose (decision 22). A non-cycle workout's macrocycle has no status to keep, and a set whose
 * macrocycle has no row gets none.
 */
export function withStatuses<R extends LiftRecordExportRow>(
  records: readonly R[],
  macrocycles: readonly MacrocycleStatusRow[],
): R[] {
  const key = (program: string, macrocycleNum: number) => JSON.stringify([program, macrocycleNum]);
  const statuses = new Map(macrocycles.map((m) => [key(m.program, m.macrocycleNum), m.status]));
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
  return `lift-records-${ymd(now)}${parts > 1 ? `-part-${part}-of-${parts}` : ''}.csv`;
}

/** A `YYYY-MM-DD` query value as UTC midnight, or null when it isn't a real calendar day. */
export function calendarDay(text: string): Date | null {
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || ymd(date) !== text ? null : date;
}
