import { SupplementStackState } from '@lifting-logbook/core';
import { SupplementChange, SupplementItem } from '@lifting-logbook/types';

type WithoutSeq<C> = C extends unknown ? Omit<C, 'seq'> : never;
/** A change as the caller builds it; the repository numbers it. */
export type NewSupplementChange = WithoutSeq<SupplementChange>;

/**
 * The supplement stack as stored now (#1374). `removed` is empty as loaded: a restore puts the
 * one item it needs there, read with `lastRemoved`.
 */
export interface SupplementState extends SupplementStackState {
  /** The `seq` the next change appended gets. */
  nextSeq: number;
  /** The latest change's date, or null with none. A write can't be dated earlier (ADR-046). */
  lastChangeDate: string | null;
}

/** A page of the change log: the latest `limit` changes before `beforeSeq`, or before the end. */
export interface SupplementChangePage {
  beforeSeq?: number;
  limit: number;
}

/**
 * Turns the state as loaded into the state to save, in place, and returns the changes that
 * did it. Throwing stores nothing.
 */
export type SupplementWritePlan = (state: SupplementState) => Promise<NewSupplementChange[]>;

/**
 * Per-user store of the supplement stack and its append-only change log (#1374, ADR-046). The
 * owning userId is bound at construction by the repository factory, as with the other per-user
 * repositories.
 */
export interface ISupplementRepository {
  load(): Promise<SupplementState>;
  /** A page of the log, oldest first. */
  changes(page: SupplementChangePage): Promise<SupplementChange[]>;
  /** Every change dated on or before `date` (`YYYY-MM-DD`), in `seq` order. */
  changesThrough(date: string): Promise<SupplementChange[]>;
  /** The earliest change's date, or null with none. */
  firstChangeDate(): Promise<string | null>;
  /**
   * The item as its latest `removed` change recorded it. Undefined if it was never removed, or a
   * later `restored` undid that removal: since, it may have been split as a mix, which brought its
   * parts back as items of their own, and restoring the old mix would count them twice.
   */
  lastRemoved(itemId: string): Promise<SupplementItem | undefined>;
  /**
   * Takes the user's supplement write lock, loads the state, runs `plan`, and saves what it
   * changed with the changes it returns, numbered from `nextSeq`, all or nothing. Writes for one
   * user run one at a time, so none saves over another (ADR-046). Saves nothing when the plan
   * changed nothing, and throws when it changed the state without returning a change, which
   * would leave the log behind the state. Throws `SupplementWriteConflictError` if a writer
   * that skipped the lock landed first. Returns the saved state.
   */
  write(plan: SupplementWritePlan): Promise<SupplementState>;
}
