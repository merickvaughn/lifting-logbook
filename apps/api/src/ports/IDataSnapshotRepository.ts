import { Weekday } from '@lifting-logbook/core';
import { ImportOverwriteScope, TrainingDataCounts } from '@lifting-logbook/types';
import { TrainingData, TrainingRow } from './ITrainingDataRepository';

/**
 * What a snapshot covered: the programs with rows in it, and for an overwrite, the scope the
 * lifter chose (#1182).
 */
export interface DataSnapshotScope {
  programs: string[];
  overwrite?: ImportOverwriteScope;
}

/**
 * What an overwrite changed rather than removed (#1182), which its undo puts back beside the
 * removed rows. Stored with the rows, so dates are `Date`s.
 */
export interface OverwriteChanges {
  /** The macrocycles that lost sets in a date range and stayed, as they were before, with their ids. */
  macrocycles: TrainingRow[];
  /** The current macrocycles whose start a date range cut, with their dashboard's date before. */
  dashboards: Array<{ program: string; macrocycleId: string; macrocycleDate: Date; macrocycleStartWeekday: Weekday }>;
}

/**
 * The snapshot kinds this release reads. The column is plain text, so a later release may write
 * another kind (ADR-044); a reverted release must then skip that row, not fail on it (#1351).
 */
export const SNAPSHOT_KINDS = ['clear', 'overwrite'] as const;

export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

export interface StoredSnapshotSummary {
  id: string;
  kind: SnapshotKind;
  scope: DataSnapshotScope;
  counts: TrainingDataCounts;
  createdAt: Date;
  expiresAt: Date;
}

export interface StoredSnapshot extends StoredSnapshotSummary {
  data: TrainingData;
  /** An overwrite's changes (#1182). Absent on a clear's snapshot. */
  overwrite?: OverwriteChanges;
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
