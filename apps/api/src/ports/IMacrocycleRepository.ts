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
  endDate?: Date | null;
  status: MacrocycleStatus;
  origin: MacrocycleOrigin;
}

export interface IMacrocycleRepository {
  /** Every macrocycle of a program, in start-date order, ties by number. */
  list(program: string): Promise<MacrocycleRow[]>;

  findByNumber(program: string, macrocycleNum: number): Promise<MacrocycleRow | null>;

  /** The highest stored number for a program, or 0 with none. */
  highestNumber(program: string): Promise<number>;

  /**
   * Inserts a row. Throws `MacrocycleNumberConflictError` when the program already has a
   * macrocycle with that number, such as one a concurrent request just created.
   */
  create(macrocycle: NewMacrocycle): Promise<MacrocycleRow>;

  /**
   * Ends a macrocycle: sets its end date, and its status unless the lifter chose one.
   * No-op when the program has no such number.
   */
  close(program: string, macrocycleNum: number, end: { endDate: Date | null; status: MacrocycleStatus }): Promise<void>;

  /** Deletes the program's rows except those numbered in `keep`. */
  deleteAllExcept(program: string, keep: readonly number[]): Promise<void>;
}
