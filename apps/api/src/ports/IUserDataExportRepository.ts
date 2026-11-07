import {
  LiftRecordExportRow,
  ProgramSpecExportRow,
  StrengthGoalExportRow,
  TrainingMaxExportRow,
} from '@lifting-logbook/core';

/** A stored row, without its user id, carried into `logbook.json` as it is. */
export type StoredRow = Record<string, unknown>;

/**
 * Every user-scoped table, for Download My Data (#947). Rows carry all their stored columns
 * except the user id. The CSV writers read the typed columns below; `logbook.json` writes the
 * whole row. Import batches are left out: they're internal undo state, not the user's data.
 */
export interface UserDataRows {
  liftRecords: LiftRecordExportRow[];
  trainingMaxes: (TrainingMaxExportRow & { program: string })[];
  strengthGoals: (StrengthGoalExportRow & { program: string })[];
  customPrograms: { id: string; name: string; specs: ProgramSpecExportRow[] }[];
  customLifts: { id: string; name: string }[];
  /** Null until the user changes a setting. */
  userSettings: { activeProgram: string | null } | null;
  macrocycleDashboards: StoredRow[];
  macrocycleScheduledWorkouts: StoredRow[];
  trainingMaxHistory: StoredRow[];
  bodyWeights: StoredRow[];
  workoutDateOverrides: StoredRow[];
  workoutSkipOverrides: StoredRow[];
  workoutLiftOverrides: StoredRow[];
  liftMetadata: StoredRow[];
  liftModifications: StoredRow[];
  focusBlocks: StoredRow[];
  focusDayStates: StoredRow[];
}

export interface IUserDataExportRepository {
  /** Reads every table for this user, across all programs. */
  readAll(): Promise<UserDataRows>;
}
