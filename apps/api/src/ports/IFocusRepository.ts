import { FocusBlock, FocusBudget, FocusDayState } from '@lifting-logbook/types';

/** A focus block's editable fields. `id` and `series` are fixed once created. */
export type FocusBlockPatch = Partial<Omit<FocusBlock, 'id' | 'series'>>;

/**
 * Per-user store of focus blocks, per-workout focus choices, and the daily focus guide
 * (#1056). The owning userId is bound at construction by the repository factory, never
 * passed per call, as with the other per-user repositories.
 *
 * Status is not stored: callers derive it from a block's dates (ADR-039).
 */
export interface IFocusRepository {
  /** Every focus block, highest priority first. */
  listBlocks(): Promise<FocusBlock[]>;
  getBlock(id: string): Promise<FocusBlock | null>;
  /**
   * Locks the user's listed blocks until the request's transaction ends, waiting for any
   * write in progress on them, and returns them as stored once locked, in id order. A block
   * the user doesn't have, or that was deleted meanwhile, is left out. A caller that writes a
   * block's pool computed from its current pool reads it here, so no other request's write
   * lands between that read and the write (ADR-039, Amendment 5).
   */
  lockBlocks(ids: readonly string[]): Promise<FocusBlock[]>;
  /**
   * Stores a block under the caller-assigned `id`. Throws `FocusBlockConflictError` when the
   * series already has a block starting on the same date.
   */
  createBlock(block: FocusBlock): Promise<FocusBlock>;
  /**
   * Stores each block whose (series, start) is still free and silently skips the rest, so
   * two reads racing to create the same auto-roll successor store it once.
   */
  createBlocksIfAbsent(blocks: readonly FocusBlock[]): Promise<void>;
  /** Throws `FocusBlockNotFoundError` when the user has no such block. */
  updateBlock(id: string, patch: FocusBlockPatch): Promise<FocusBlock>;
  /** Throws `FocusBlockNotFoundError` when the user has no such block. */
  deleteBlock(id: string): Promise<void>;
  /** Sets each listed block's priority. Ids the user does not own are ignored. */
  setPriorities(priorities: readonly { id: string; priority: number }[]): Promise<void>;

  /** The daily focus guide, with `DEFAULT_FOCUS_BUDGET` filling any unset value. */
  getBudget(): Promise<FocusBudget>;
  setBudget(budget: FocusBudget): Promise<FocusBudget>;

  /** The workout's saved focus choices, or null when none are saved. */
  getDayState(program: string, macrocycleNum: number, workoutNum: number): Promise<FocusDayState | null>;
  saveDayState(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    state: FocusDayState,
  ): Promise<FocusDayState>;
}
