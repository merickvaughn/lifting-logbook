import { TrainingDataCounts } from '@lifting-logbook/types';
import { TrainingData } from './ITrainingDataRepository';

/** What a snapshot covered. Clear data takes every program; these are the ones with rows. */
export interface DataSnapshotScope {
  programs: string[];
}

export interface StoredSnapshotSummary {
  id: string;
  kind: 'clear';
  scope: DataSnapshotScope;
  counts: TrainingDataCounts;
  createdAt: Date;
  expiresAt: Date;
}

export interface StoredSnapshot extends StoredSnapshotSummary {
  data: TrainingData;
}

export type NewSnapshot = Omit<StoredSnapshot, 'id'>;

/**
 * Snapshots of a user's training data (#1309, proposal decision 21). Every read treats a
 * snapshot past `expiresAt` as gone, so one the daily job hasn't deleted yet still can't be
 * listed, restored or downloaded.
 */
export interface IDataSnapshotRepository {
  /** Saves a snapshot. Throws when it can't be stored, before the caller clears anything. */
  create(snapshot: NewSnapshot): Promise<StoredSnapshotSummary>;

  /** This user's unexpired snapshots, newest first. */
  list(now: Date): Promise<StoredSnapshotSummary[]>;

  /** The snapshot with its rows, or null when it doesn't exist, isn't this user's or has expired. */
  get(id: string, now: Date): Promise<StoredSnapshot | null>;

  /** Deletes the snapshot. Returns false when this user has no snapshot with that id. */
  delete(id: string): Promise<boolean>;
}
