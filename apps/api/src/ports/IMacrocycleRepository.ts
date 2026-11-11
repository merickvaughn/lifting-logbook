import { MacrocycleOrigin, MacrocycleStatus } from '@lifting-logbook/types';

/** A `macrocycle` row (ADR-042). Dates are UTC midnights. */
export interface MacrocycleRow {
  /** Stable across renumbering; `macrocycleNum` isn't. */
  id: string;
  program: string;
  macrocycleNum: number;
  startDate: Date;
  endDate: Date | null;
  status: MacrocycleStatus;
  /** The lifter set `status`, so no rule may change it. */
  statusChosen: boolean;
  origin: MacrocycleOrigin;
  unmatched: boolean;
  /** A continued imported run's sets dated up to here came from a file (#1180). */
  importedThrough: Date | null;
}

export interface NewMacrocycle {
  program: string;
  macrocycleNum: number;
  startDate: Date;
  endDate?: Date;
  status: MacrocycleStatus;
  origin: MacrocycleOrigin;
}

export interface IMacrocycleRepository {
  /**
   * Takes the user's macrocycle write lock (proposal decision 13) in shared mode until the
   * request's transaction ends, without waiting. Page writes share it, so they run side by side.
   * False when an import holds it exclusively.
   *
   * The lock lasts only as long as the transaction it's taken in. Under the RLS request
   * transaction (`DATABASE_URL`) that's the request. A repository on a bare client, as the
   * `SYSTEM_DATABASE_URL` factory builds, has no request transaction, so the lock ends with its
   * own statement and excludes nothing.
   */
  tryLockShared(): Promise<boolean>;

  /**
   * Takes the same lock exclusively until the request's transaction ends, so nothing else writes
   * to the user's macrocycles while an import runs. Waits up to `waitMs` for the page writes
   * holding it to finish; false if they haven't by then.
   */
  lockExclusive(waitMs: number): Promise<boolean>;

  /** Every macrocycle of a program, in start-date order, ties by number. */
  list(program: string): Promise<MacrocycleRow[]>;

  /** The user's row with this stable id, in any program. */
  findById(id: string): Promise<MacrocycleRow | null>;

  findByNumber(program: string, macrocycleNum: number): Promise<MacrocycleRow | null>;

  /** The highest stored number for a program, or 0 with none. */
  highestNumber(program: string): Promise<number>;

  /**
   * Inserts a row. Throws `MacrocycleNumberConflictError` when the program already has a
   * macrocycle with that number, such as one a concurrent request just created.
   */
  create(macrocycle: NewMacrocycle): Promise<MacrocycleRow>;

  /** Inserts rows in one statement, throwing as {@link create} does when a number is taken. */
  createMany(macrocycles: readonly NewMacrocycle[]): Promise<void>;

  /**
   * Inserts each row whose number the program doesn't have yet, and leaves the rest alone, so
   * two requests ensuring the same row both succeed.
   */
  ensure(macrocycles: readonly NewMacrocycle[]): Promise<void>;

  /**
   * Ends a macrocycle: sets its end date and status. No-op when the program has no such
   * number. The caller keeps a status the lifter chose.
   */
  close(program: string, macrocycleNum: number, end: { endDate: Date; status: MacrocycleStatus }): Promise<void>;

  /**
   * Deletes the program's macrocycles numbered in `macrocycleNums` from every table that holds a
   * number (the tables {@link rewriteNumbers} lists), so nothing is left on a number a
   * renumbering then moves another macrocycle onto (#1199).
   */
  delete(program: string, macrocycleNums: readonly number[]): Promise<void>;

  /** Deletes the program's rows except those numbered in `keep`. */
  deleteAllExcept(program: string, keep: readonly number[]): Promise<void>;

  /**
   * Renumbers the program's macrocycles (proposal decision 3): rewrites each old number in
   * `changes` to its new one in every table that holds a number — `lift_record`,
   * `macrocycle_dashboard`, the three workout override tables, `focus_day_state`,
   * `macrocycle_scheduled_workout` and `macrocycle` — through a temporary negative number, since
   * the unique keys are checked per row. Returns how many rows changed. Import batch keys are the
   * caller's. Throws `MacrocycleNumberConflictError`, naming the table, before it moves anything
   * if a row in any of those tables holds a new number that `changes` doesn't move.
   */
  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): Promise<number>;
}
