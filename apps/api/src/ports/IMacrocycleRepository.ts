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

/**
 * The user's macrocycle write lock (proposal decision 13). Page writes take it `shared`, so
 * they run side by side; imports take it `exclusive`, so nothing writes while one runs.
 */
export type MacrocycleLockMode = 'shared' | 'exclusive';

export interface IMacrocycleRepository {
  /**
   * Tries to take the user's macrocycle write lock until the request's transaction ends, without
   * waiting. False when a conflicting holder has it.
   */
  tryLock(mode: MacrocycleLockMode): Promise<boolean>;

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

  /** Deletes the program's rows numbered in `macrocycleNums`. */
  delete(program: string, macrocycleNums: readonly number[]): Promise<void>;

  /** Deletes the program's rows except those numbered in `keep`. */
  deleteAllExcept(program: string, keep: readonly number[]): Promise<void>;
}
