import { LiftRecord, SetSlot } from '@lifting-logbook/core';

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
   * Every set the user has stored on one of `slots`' dates under one of its lift's spellings
   * (#1135), in any program: what an import's count-based duplicate check
   * (`classifyLiftRecordRows`, proposal decision 13) compares a file with. Goes by the built-in
   * spellings alone, so a row stored as the text of a custom lift named like one can match it.
   */
  findStoredSets(slots: readonly SetSlot[]): Promise<LiftRecord[]>;

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
}
