import { LiftRecord } from '@lifting-logbook/core';

export interface DateRange {
  first: Date;
  last: Date;
}

/** Each macrocycle number's first and last date among `rows`. */
export function dateRangesByMacrocycle(rows: Iterable<{ macrocycleNum: number; date: Date }>): Map<number, DateRange> {
  const ranges = new Map<number, DateRange>();
  for (const { macrocycleNum, date } of rows) {
    const range = ranges.get(macrocycleNum);
    if (!range) ranges.set(macrocycleNum, { first: date, last: date });
    else {
      if (date < range.first) range.first = date;
      if (date > range.last) range.last = date;
    }
  }
  return ranges;
}

export interface ILiftRecordRepository {
  getLiftRecords(program: string, macrocycleNum: number): Promise<LiftRecord[]>;

  /**
   * The distinct `workoutNum`s with at least one logged record in the macrocycle —
   * what the macrocycle dashboard's `completedWorkoutNums` is built from. A grouped
   * query rather than `getLiftRecords` + a reduce, which fetched every column
   * of every row in the macrocycle to keep a handful of integers (issue #982).
   */
  getLoggedWorkoutNums(program: string, macrocycleNum: number): Promise<Set<number>>;

  /**
   * Every record of the given lifts dated on or before `through`, across all of the user's
   * programs and macrocycles — what a focus block summary needs, since focus blocks run on
   * a timeline of their own (#1056). Served by `@@index([userId, lift, date])`.
   *
   * Finds a lift under any stored spelling (`liftSpellings`, #1135), and each record keeps
   * the name it is stored under. With `from`, only records dated on or after it: the focus
   * plan read needs only the active blocks' ranges (#1221).
   */
  getRecordsForLifts(lifts: readonly string[], through: Date, from?: Date): Promise<LiftRecord[]>;

  /**
   * Appends records for a program, silently skipping any whose natural key already exists.
   * Returns the number of rows actually inserted (i.e. excluding duplicates).
   */
  appendLiftRecords(program: string, records: LiftRecord[]): Promise<number>;

  /**
   * Returns the subset of `candidates` whose natural key
   * (macrocycleNum, workoutNum, date, lift, setNum) already exists for the given program.
   * `date` is part of the key (issue #884): two sets can otherwise legitimately
   * share the same (macrocycleNum, workoutNum, lift, setNum) tuple on different real
   * calendar dates and must not be treated as duplicates of each other.
   * A set under another spelling of a built-in lift counts too, when weight and reps also match
   * (`findAlreadyLogged`, #947). That goes by the built-in spellings alone, so a row stored as the
   * text of a custom lift named like one can match it.
   * Used by the CSV import endpoint to identify which rows will be skipped as duplicates.
   */
  findExistingRecords(program: string, candidates: LiftRecord[]): Promise<LiftRecord[]>;

  updateLiftRecord(
    program: string,
    id: string,
    updates: Partial<Pick<LiftRecord, 'weight' | 'reps' | 'notes' | 'modifications'>>,
  ): Promise<LiftRecord | null>;

  /**
   * Deletes lift records by natural key for undo support.
   * Each key is encoded as `"macrocycleNum:workoutNum:YYYYMMDD:lift:setNum"`.
   * Returns the number of rows deleted.
   */
  deleteLiftRecordsByNaturalKeys(program: string, naturalKeys: string[]): Promise<number>;

  /**
   * Each macrocycle's first and last record date, keyed by number, for the program, or for
   * just `macrocycleNum` when given. Numbers with no records are absent. A grouped query, so a
   * list of macrocycles reads no sets.
   */
  getMacrocycleDateRanges(program: string, macrocycleNum?: number): Promise<Map<number, DateRange>>;

  /**
   * Deletes every lift record for a program, across all macrocycles except those numbered in
   * `keep`. No-op if none exist.
   */
  deleteAllLiftRecords(program: string, keep?: readonly number[]): Promise<void>;
}
