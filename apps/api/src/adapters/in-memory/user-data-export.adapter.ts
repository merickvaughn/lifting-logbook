import { LiftRecord, LiftRecordExportRow } from '@lifting-logbook/core';
import { ICustomLiftRepository } from '../../ports/ICustomLiftRepository';
import { InMemoryGoogleSheetLinkRepository } from './google-sheet-link.adapter';
import {
  IUserDataExportRepository,
  LiftRecordExportFilter,
  UserDataRows,
} from '../../ports/IUserDataExportRepository';
import { IUserSettingsRepository } from '../../ports/IUserSettingsRepository';
import { InMemoryStrengthGoalRepository } from './strength-goal.adapter';
import { InMemorySupplementRepository } from './supplement.adapter';
import { InMemoryTrainingMaxRepository } from './training-max.adapter';

/**
 * Lift records, training maxes, strength goals, custom lifts, settings, supplements and the Google
 * Sheet link, which is
 * what the endpoint's in-memory tests read. Every other table is empty here, and row shapes and order
 * follow the in-memory stores. Only Postgres is authoritative for `logbook.json`, which is proven
 * in data-export.db.e2e.spec.ts.
 */
export class InMemoryUserDataExportRepository implements IUserDataExportRepository {
  constructor(
    private readonly records: ReadonlyMap<string, LiftRecord[]>,
    private readonly trainingMax: InMemoryTrainingMaxRepository,
    private readonly strengthGoal: InMemoryStrengthGoalRepository,
    private readonly customLift: ICustomLiftRepository,
    private readonly userSettings: IUserSettingsRepository,
    private readonly supplement: InMemorySupplementRepository,
    private readonly googleSheetLink: InMemoryGoogleSheetLinkRepository,
  ) {}

  private allLiftRecords(): LiftRecordExportRow[] {
    return [...this.records].flatMap(([program, rows]) =>
      rows.map((r) => ({
        ...r,
        program,
        occurrence: r.occurrence ?? 0,
        modifications: r.modifications ?? [],
      })),
    );
  }

  async readLiftRecords(filter: LiftRecordExportFilter): Promise<LiftRecordExportRow[]> {
    return this.allLiftRecords().filter(
      (r) =>
        (filter.program === undefined || r.program === filter.program) &&
        (filter.macrocycleNum === undefined || r.macrocycleNum === filter.macrocycleNum) &&
        (filter.from === undefined || r.date.getTime() >= filter.from.getTime()) &&
        (filter.to === undefined || r.date.getTime() <= filter.to.getTime()),
    );
  }

  async readAll(): Promise<UserDataRows> {
    const settings = await this.userSettings.getSettings();
    return {
      liftRecords: this.allLiftRecords(),
      trainingMaxes: this.trainingMax.allByProgram(),
      strengthGoals: this.strengthGoal.allByProgram(),
      customPrograms: [],
      customLifts: (await this.customLift.list()).map((lift) => {
        const { userId: _userId, ...rest } = lift;
        return rest;
      }),
      userSettings: settings,
      macrocycles: [],
      macrocycleDashboards: [],
      macrocycleScheduledWorkouts: [],
      trainingMaxHistory: [],
      bodyWeights: [],
      workoutDateOverrides: [],
      workoutSkipOverrides: [],
      workoutLiftOverrides: [],
      liftMetadata: [],
      liftModifications: [],
      liftModificationMaxes: [],
      missingMaxDismissals: [],
      focusBlocks: [],
      focusDayStates: [],
      googleSheetLinks: this.googleSheetLink.exportRows(),
      ...this.supplement.exportRows(),
    };
  }
}
