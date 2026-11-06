import { LiftModification, LiftModificationMaxMode } from '@lifting-logbook/types';

export interface CreateLiftModificationInput {
  /** The lift's id: a catalog id, or a custom lift's uuid. */
  lift: string;
  name: string;
  description?: string;
  maxMode?: LiftModificationMaxMode;
}

export interface UpdateLiftModificationPatch {
  name?: string;
  description?: string;
  maxMode?: LiftModificationMaxMode;
}

/**
 * Per-user store of lift modifications. The owning userId is bound to the adapter at construction
 * time (via the repository factory), never passed per call, like the other per-user repositories.
 */
export interface ILiftModificationRepository {
  /** Every modification of this user, archived ones included, since old sets still name them. */
  list(): Promise<LiftModification[]>;

  /**
   * Creates a modification, or brings back an archived one of the same lift and name with the
   * given description and `maxMode`, so its old sets and any new ones share one id.
   * Throws `LiftModificationConflictError` if a live one has that name.
   */
  create(input: CreateLiftModificationInput): Promise<LiftModification>;

  /**
   * Throws `LiftModificationNotFoundError` for an unknown or archived id, and
   * `LiftModificationConflictError` if the new name is taken on this lift.
   */
  update(id: string, patch: UpdateLiftModificationPatch): Promise<LiftModification>;

  /**
   * Removes a modification no logged set names, and archives one a set does, so the set still
   * names it. Throws `LiftModificationNotFoundError` for an unknown id.
   */
  delete(id: string): Promise<void>;
}
