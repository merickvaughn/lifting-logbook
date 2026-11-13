import { TrainingMax } from '@lifting-logbook/core';
import { ImportWriteResult } from '@lifting-logbook/types';

export interface ITrainingMaxRepository {
  getTrainingMaxes(program: string): Promise<TrainingMax[]>;

  /**
   * Upserts the given training maxes for a program, keyed by lift. Lifts that
   * are not present in `maxes` are left untouched — this is an upsert, NOT a
   * full replace, so callers may safely pass a subset of a program's lifts.
   *
   * Both adapters must honour this contract: the Prisma adapter upserts each
   * row by `(userId, program, lift)`, and the in-memory adapter merges by lift.
   * A full-replace implementation here would silently wipe omitted lifts on a
   * partial Smart Import (#477) — the divergence fixed in #485. There is
   * intentionally no delete-via-save path.
   */
  saveTrainingMaxes(program: string, maxes: TrainingMax[]): Promise<void>;

  /**
   * Smart Import commit (#488): atomically upsert `maxes` by lift and return the
   * own `{created, updated, skipped}` counts of the write — so commit counts come
   * from the write itself, not a separate pre-read that a concurrent edit could
   * invalidate. Duplicate lifts within the batch collapse to the row with the most
   * recent `dateUpdated`, with file order breaking a tie (`latestTrainingMaxFirst`,
   * matching the preview, #1117). The whole batch runs in one transaction; a partial
   * failure rolls back.
   */
  importTrainingMaxes(program: string, maxes: TrainingMax[]): Promise<ImportWriteResult>;

  /** Deletes training maxes by lift name for undo support. */
  deleteTrainingMaxes(program: string, lifts: string[]): Promise<void>;

  /** Deletes every training max for a program, regardless of lift. No-op if none exist. */
  deleteAllTrainingMaxes(program: string): Promise<void>;

  /**
   * The stable ids (#1139) of the lifts the user answered "Don't ask again" for in this program,
   * on the offer to set up a missing training max (#1246). A dismissal survives a macrocycle
   * delete, as the user's custom lifts do: it is their answer about the lift.
   */
  getMissingMaxDismissals(program: string): Promise<string[]>;

  /** Stores "Don't ask again" for a lift, by stable id. A no-op if it is already stored. */
  dismissMissingMax(program: string, liftId: string): Promise<void>;

  /** Clears "Don't ask again" for a lift, by stable id ("Ask again"). A no-op if none is stored. */
  undismissMissingMax(program: string, liftId: string): Promise<void>;
}
