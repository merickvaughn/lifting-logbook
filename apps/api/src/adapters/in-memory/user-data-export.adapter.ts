import { LiftRecord } from '@lifting-logbook/core';
import { ICustomLiftRepository } from '../../ports/ICustomLiftRepository';
import { IUserDataExportRepository, UserDataRows } from '../../ports/IUserDataExportRepository';
import { IUserSettingsRepository } from '../../ports/IUserSettingsRepository';
import { InMemoryStrengthGoalRepository } from './strength-goal.adapter';
import { InMemoryTrainingMaxRepository } from './training-max.adapter';

/**
 * Lift records, training maxes, strength goals, custom lifts and settings, which is what the
 * endpoint's in-memory tests read. Every other table is empty here: `logbook.json` coverage is
 * proven against Postgres, in user-data-export.db.e2e.spec.ts.
 */
export class InMemoryUserDataExportRepository implements IUserDataExportRepository {
  constructor(
    private readonly records: ReadonlyMap<string, LiftRecord[]>,
    private readonly trainingMax: InMemoryTrainingMaxRepository,
    private readonly strengthGoal: InMemoryStrengthGoalRepository,
    private readonly customLift: ICustomLiftRepository,
    private readonly userSettings: IUserSettingsRepository,
  ) {}

  async readAll(): Promise<UserDataRows> {
    const settings = await this.userSettings.getSettings();
    return {
      liftRecords: [...this.records].flatMap(([program, rows]) =>
        rows.map((r) => ({
          ...r,
          program,
          occurrence: r.occurrence ?? 0,
          modifications: r.modifications ?? [],
        })),
      ),
      trainingMaxes: this.trainingMax.allByProgram(),
      strengthGoals: this.strengthGoal.allByProgram(),
      customPrograms: [],
      customLifts: await this.customLift.list(),
      userSettings: settings,
      macrocycleDashboards: [],
      macrocycleScheduledWorkouts: [],
      trainingMaxHistory: [],
      bodyWeights: [],
      workoutDateOverrides: [],
      workoutSkipOverrides: [],
      workoutLiftOverrides: [],
      liftMetadata: [],
      liftModifications: [],
      focusBlocks: [],
      focusDayStates: [],
    };
  }
}
