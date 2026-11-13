import { LiftRecord, SetSlot, liftIdFor } from '@lifting-logbook/core';

/**
 * Each lift's latest session among `sets`, keyed by `liftIdFor`: the `workoutNum` of the latest
 * date, the higher number on a tie. What {@link ILiftRecordRepository.getLastSessions} picks by.
 */
export function latestWorkoutByLift(sets: Iterable<{ lift: string; workoutNum: number; date: Date }>): Map<string, number> {
  const latest = new Map<string, { workoutNum: number; date: Date }>();
  for (const { lift, workoutNum, date } of sets) {
    const id = liftIdFor(lift);
    const current = latest.get(id);
    const later = !current || date > current.date || (date.getTime() === current.date.getTime() && workoutNum > current.workoutNum);
    if (later) latest.set(id, { workoutNum, date });
  }
  return new Map([...latest].map(([id, { workoutNum }]) => [id, workoutNum]));
}

/** `sets` keyed by `liftIdFor`, each lift's in set order: the shape `getLastSessions` returns. */
export function setsByLift(sets: Iterable<LiftRecord>): Map<string, LiftRecord[]> {
  const byLift = new Map<string, LiftRecord[]>();
  for (const set of sets) {
    const id = liftIdFor(set.lift);
    const lift = byLift.get(id);
    if (lift) lift.push(set);
    else byLift.set(id, [set]);
  }
  for (const lift of byLift.values()) lift.sort((a, b) => a.setNum - b.setNum);
  return byLift;
}

/** The workout {@link ILiftRecordRepository.getLastSessions} reads the lifts' last sessions before. */
export interface LastSessionsBefore {
  workoutNum: number;
  /** The workout's date, its override's when rescheduled: sessions dated after it don't count. */
  through: Date;
}

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
  /** The macrocycle's records, or only workout `workoutNum`'s when it's given. */
  getLiftRecords(program: string, macrocycleNum: number, workoutNum?: number): Promise<LiftRecord[]>;

  /**
   * The distinct `workoutNum`s with at least one logged record in the macrocycle —
   * what the macrocycle dashboard's `completedWorkoutNums` is built from. A grouped
   * query rather than `getLiftRecords` + a reduce, which fetched every column
   * of every row in the macrocycle to keep a handful of integers (issue #982).
   */
  getLoggedWorkoutNums(program: string, macrocycleNum: number): Promise<Set<number>>;

  /**
   * Each of `lifts`' last session before a workout, keyed by `liftIdFor` ({@link setsByLift}): the
   * sets of the latest other workout in the macrocycle dated on or before `before.through`
   * ({@link latestWorkoutByLift}), under any spelling of the lift (`liftSpellings`), and only the
   * lift's first occurrence in each workout. A lift with none is absent. What `GET /workouts/:n`
   * reports as each lift's `lastSession`, which a `double` lift plans from (#1252). Two narrow
   * queries, so the web no longer reads the whole macrocycle for it.
   */
  getLastSessions(
    program: string,
    macrocycleNum: number,
    lifts: readonly string[],
    before: LastSessionsBefore,
  ): Promise<Map<string, LiftRecord[]>>;

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
   * The distinct lift names the program's records are stored under, in any macrocycle: where
   * the missing-training-max list starts (#1246). A grouped query: it returns no sets, but scans
   * one index entry per stored set in the program.
   */
  getLoggedLifts(program: string): Promise<string[]>;

  /**
   * Every record in the program, in any macrocycle, stored under exactly one of `lifts`. Unlike
   * {@link getRecordsForLifts} it doesn't expand spellings: pass names from {@link getLoggedLifts}.
   * Each record carries only the fields the missing-training-max list reads (`notes` is empty).
   */
  getProgramRecordsForLifts(program: string, lifts: readonly string[]): Promise<LiftRecord[]>;

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
