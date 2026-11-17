import { LiftRecordExportRow } from '@lifting-logbook/core';
import { TrainingDataCounts } from '@lifting-logbook/types';
import { MacrocycleRow } from './IMacrocycleRepository';

/** The tables Clear data removes (proposal decision 20, #1309), by their `TrainingDataCounts` key. */
export type TrainingTable = keyof TrainingDataCounts;

/** In the order a restore inserts them, so a row's macrocycle is stored before its sets. */
export const TRAINING_TABLES: readonly TrainingTable[] = [
  'macrocycles',
  'liftRecords',
  'macrocycleDashboards',
  'macrocycleScheduledWorkouts',
  'trainingMaxes',
  'trainingMaxHistory',
  'liftModificationMaxes',
  'workoutDateOverrides',
  'workoutSkipOverrides',
  'workoutLiftOverrides',
  'focusDayStates',
  'importBatches',
];

/** The tables whose rows hold a macrocycle number, which a restore moves past the stored ones. */
export const NUMBERED_TRAINING_TABLES: readonly TrainingTable[] = [
  'macrocycles',
  'liftRecords',
  'macrocycleDashboards',
  'macrocycleScheduledWorkouts',
  'workoutDateOverrides',
  'workoutSkipOverrides',
  'workoutLiftOverrides',
  'focusDayStates',
];

/**
 * One stored row without its user id. Its other columns are the adapter's own, and only that
 * adapter writes it back, but every row names its `program`, and a row of a numbered table holds
 * `macrocycleNum` and, where it has one, `workoutNum`, which a restore may change. Dates are
 * `Date`s.
 */
export type TrainingRow = Record<string, unknown> & { program: string; macrocycleNum?: number; workoutNum?: number };

/** A user's training data, by table. */
export type TrainingData = Record<TrainingTable, TrainingRow[]>;

/**
 * The sets, which both adapters write with `LiftRecordExportRow`'s columns, so a snapshot's sets
 * download as decision 22's CSV.
 */
export function liftRecordRows(data: TrainingData): (LiftRecordExportRow & TrainingRow)[] {
  return data.liftRecords as (LiftRecordExportRow & TrainingRow)[];
}

/** The macrocycles, which both adapters write with `MacrocycleRow`'s columns, for restore to close one. */
export function macrocycleRows(data: TrainingData): (MacrocycleRow & TrainingRow)[] {
  return data.macrocycles as (MacrocycleRow & TrainingRow)[];
}

export interface ITrainingDataRepository {
  /** Every row of the cleared tables for this user. */
  read(): Promise<TrainingData>;

  /** How many rows each cleared table holds for this user. */
  counts(): Promise<TrainingDataCounts>;

  /**
   * Locks this user's rows in every cleared table until the transaction ends, so no other write
   * changes or deletes one before it does, and returns how many each table holds.
   */
  lockRows(): Promise<TrainingDataCounts>;

  /** Deletes this user's rows from every cleared table, and returns how many each table lost. */
  clear(): Promise<TrainingDataCounts>;

  /**
   * Inserts `data`'s rows, skipping any whose key a stored row holds: a program's dashboard, a
   * lift's training max, a modification's own max, or a row on the same macrocycle, workout and
   * set. A modification's own max is skipped too when the modification no longer exists.
   * Returns how many rows each table took.
   */
  insertMissing(data: TrainingData): Promise<TrainingDataCounts>;

  /**
   * Runs `fn`, then undoes every write it made to this user's cleared tables, whether it returned
   * or threw, and returns or rethrows what it did. An overwrite's dry run (#1182) removes the
   * scope's rows this way, so it counts what the commit would write against what would be left.
   */
  discardChanges<T>(fn: () => Promise<T>): Promise<T>;
}
