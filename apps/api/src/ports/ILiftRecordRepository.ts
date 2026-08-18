import { LiftRecord } from '@lifting-logbook/core';

export interface ILiftRecordRepository {
  getLiftRecords(program: string, cycleNum: number): Promise<LiftRecord[]>;

  /**
   * Appends records for a program, silently skipping any whose natural key already exists.
   * Returns the number of rows actually inserted (i.e. excluding duplicates).
   */
  appendLiftRecords(program: string, records: LiftRecord[]): Promise<number>;

  /**
   * Returns the subset of `candidates` whose natural key
   * (cycleNum, workoutNum, date, lift, setNum) already exists for the given program.
   * `date` is part of the key (issue #884): two sets can otherwise legitimately
   * share the same (cycleNum, workoutNum, lift, setNum) tuple on different real
   * calendar dates and must not be treated as duplicates of each other.
   * Used by the CSV import endpoint to identify which rows will be skipped as duplicates.
   */
  findExistingRecords(program: string, candidates: LiftRecord[]): Promise<LiftRecord[]>;

  updateLiftRecord(
    program: string,
    id: string,
    updates: Partial<Pick<LiftRecord, 'weight' | 'reps' | 'notes'>>,
  ): Promise<LiftRecord | null>;

  /**
   * Deletes lift records by natural key for undo support.
   * Each key is encoded as `"cycleNum:workoutNum:YYYYMMDD:lift:setNum"`.
   * Returns the number of rows deleted.
   */
  deleteLiftRecordsByNaturalKeys(program: string, naturalKeys: string[]): Promise<number>;

  /** Deletes every lift record for a program, across all cycles. No-op if none exist. */
  deleteAllLiftRecords(program: string): Promise<void>;
}
