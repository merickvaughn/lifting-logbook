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
  /** Typed where the lift-record CSV reads each set's status (#1308). */
  macrocycles: (StoredRow & { program: string; macrocycleNum: number; status: string; statusChosen: boolean })[];
  macrocycleDashboards: StoredRow[];
  macrocycleScheduledWorkouts: StoredRow[];
  trainingMaxHistory: StoredRow[];
  bodyWeights: StoredRow[];
  workoutDateOverrides: StoredRow[];
  workoutSkipOverrides: StoredRow[];
  workoutLiftOverrides: StoredRow[];
  liftMetadata: StoredRow[];
  liftModifications: StoredRow[];
  /** Own maxes of modifications (#1153), across programs. */
  liftModificationMaxes: StoredRow[];
  /** "Don't ask again" answers on the missing-training-max prompts (#1270), across programs. */
  missingMaxDismissals: StoredRow[];
  focusBlocks: StoredRow[];
  focusDayStates: StoredRow[];
}

/**
 * Which sets a filtered export takes (#1308, decision 22). Every field narrows it; none means all
 * of them. `macrocycleNum` needs `program`, since numbers are per program. Dates are UTC midnights
 * and both ends are included.
 */
export interface LiftRecordExportFilter {
  program?: string;
  macrocycleNum?: number;
  from?: Date;
  to?: Date;
}

export interface IUserDataExportRepository {
  /** Reads every table for this user, across all programs. */
  readAll(): Promise<UserDataRows>;

  /** This user's sets that `filter` takes, in `readAll`'s order. */
  readLiftRecords(filter: LiftRecordExportFilter): Promise<LiftRecordExportRow[]>;
}
