import { LiftRecord, SpreadsheetCell } from '../../models';

/**
 * A lift record as `segmentLiftHistory` reads it (#1253): a `Program`, `Macrocycle #` or
 * `Workout #` the file leaves blank or doesn't map is `null`, never a default. One finite
 * macrocycle number turns the whole file over to its own numbering, so a default would
 * change what's grouped.
 */
export type LiftHistoryRecord = Omit<LiftRecord, 'program' | 'macrocycleNum' | 'workoutNum'> & {
  program: string | null;
  macrocycleNum: number | null;
  workoutNum: number | null;
};

/**
 * Reads a record parsed with `parseLiftRecords(table, { assign: true })` as a
 * {@link LiftHistoryRecord}. That parse already reads a blank or missing number as `NaN`.
 */
export function toLiftHistoryRecord(record: LiftRecord): LiftHistoryRecord {
  const program = typeof record.program === 'string' ? record.program.trim() : '';
  return {
    ...record,
    program: program === '' ? null : record.program,
    macrocycleNum: Number.isFinite(record.macrocycleNum) ? record.macrocycleNum : null,
    workoutNum: Number.isFinite(record.workoutNum) ? record.workoutNum : null,
  };
}

/**
 * True when a lift-records file is this app's own export: only the export writes an
 * `Occurrence` column (proposal decision 22, the classifier's `exportToken`). Its macrocycles
 * may overlap (decision 8), and it isn't split into training maxes.
 */
export function isLiftRecordExport(headers: readonly SpreadsheetCell[]): boolean {
  return headers.some((h) => String(h ?? '').trim().toLowerCase() === 'occurrence');
}
