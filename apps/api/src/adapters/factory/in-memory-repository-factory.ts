import { Injectable } from '@nestjs/common';
import { LiftRecord } from '@lifting-logbook/core';
import { AuthUser } from '../../ports/auth';
import { IRepositoryFactory, RepositoryBundle } from '../../ports/factory';
import { InMemoryBodyWeightRepository } from '../in-memory/body-weight.adapter';
import { InMemoryCustomLiftRepository } from '../in-memory/custom-lift.adapter';
import { InMemoryFocusRepository } from '../in-memory/focus.adapter';
import { InMemoryMacrocycleDashboardRepository } from '../in-memory/macrocycle-dashboard.adapter';
import { InMemoryMacrocycleRepository } from '../in-memory/macrocycle.adapter';
import { InMemoryMacrocycleScheduledWorkoutRepository } from '../in-memory/macrocycle-scheduled-workout.adapter';
import { InMemoryImportBatchRepository } from '../in-memory/import-batch.adapter';
import { InMemoryLiftMetadataRepository } from '../in-memory/lift-metadata.adapter';
import { InMemoryLiftingProgramSpecRepository } from '../in-memory/lifting-program-spec.adapter';
import { InMemoryLiftModificationRepository } from '../in-memory/lift-modification.adapter';
import { InMemoryLiftRecordRepository } from '../in-memory/lift-record.adapter';
import { InMemoryProgramPhilosophyRepository } from '../in-memory/program-philosophy.adapter';
import { InMemoryStrengthGoalRepository } from '../in-memory/strength-goal.adapter';
import { InMemoryTrainingMaxRepository } from '../in-memory/training-max.adapter';
import { InMemoryTrainingMaxHistoryRepository } from '../in-memory/training-max-history.adapter';
import { InMemoryUserDataExportRepository } from '../in-memory/user-data-export.adapter';
import { InMemoryUserSettingsRepository } from '../in-memory/user-settings.adapter';
import { InMemoryWorkoutDateOverrideRepository } from '../in-memory/workout-date-override.adapter';
import { InMemoryWorkoutLiftOverrideRepository } from '../in-memory/workout-lift-override.adapter';
import { InMemoryWorkoutRepository } from '../in-memory/workout.adapter';
import { InMemoryWorkoutSkipOverrideRepository } from '../in-memory/workout-skip-override.adapter';
import { SEED_PROGRAM, seedLiftRecords, seedMacrocycleRow } from '../in-memory/fixtures';
import { numberedStoresIn } from '../in-memory/renumber';

// The dev seed user gets pre-populated training maxes so existing tests that
// rely on seeded data continue to work without additional setup.
const SEED_USER_ID = process.env.DEV_USER_ID || 'dev-token';

@Injectable()
export class InMemoryRepositoryFactory implements IRepositoryFactory {
  private readonly bundles = new Map<string, RepositoryBundle>();

  async forUser(user: AuthUser): Promise<RepositoryBundle> {
    if (!this.bundles.has(user.id)) {
      const preSeed = user.id === SEED_USER_ID;
      // liftRecord and workout share one backing store so POSTed records are
      // immediately visible via GET /workouts/:workoutNum (mirrors Prisma behavior).
      const sharedRecords: Map<string, LiftRecord[]> = preSeed
        ? new Map([[SEED_PROGRAM, seedLiftRecords()]])
        : new Map();
      const customLift = new InMemoryCustomLiftRepository(user.id);
      const strengthGoal = new InMemoryStrengthGoalRepository();
      const trainingMax = new InMemoryTrainingMaxRepository(preSeed);
      const userSettings = new InMemoryUserSettingsRepository();
      const macrocycle = new InMemoryMacrocycleRepository(preSeed ? [seedMacrocycleRow()] : []);
      const bundle: RepositoryBundle = {
        bodyWeight: new InMemoryBodyWeightRepository(),
        customLift,
        focus: new InMemoryFocusRepository(),
        macrocycle,
        macrocycleDashboard: new InMemoryMacrocycleDashboardRepository(preSeed),
        macrocycleScheduledWorkout: new InMemoryMacrocycleScheduledWorkoutRepository(),
        importBatch: new InMemoryImportBatchRepository(),
        liftMetadata: new InMemoryLiftMetadataRepository(),
        liftingProgramSpec: new InMemoryLiftingProgramSpecRepository(preSeed),
        liftModification: new InMemoryLiftModificationRepository(user.id, sharedRecords),
        liftRecord: new InMemoryLiftRecordRepository(sharedRecords),
        programPhilosophy: new InMemoryProgramPhilosophyRepository(),
        strengthGoal,
        trainingMax,
        trainingMaxHistory: new InMemoryTrainingMaxHistoryRepository(),
        userDataExport: new InMemoryUserDataExportRepository(
          sharedRecords,
          trainingMax,
          strengthGoal,
          customLift,
          userSettings,
        ),
        userSettings,
        workout: new InMemoryWorkoutRepository(sharedRecords),
        workoutDateOverride: new InMemoryWorkoutDateOverrideRepository(),
        workoutLiftOverride: new InMemoryWorkoutLiftOverrideRepository(),
        workoutSkipOverride: new InMemoryWorkoutSkipOverrideRepository(),
      };
      // Every other store that holds a number, so a renumbering or delete reaches them all (#1199).
      macrocycle.attachNumbered(numberedStoresIn(bundle));
      this.bundles.set(user.id, bundle);
    }
    return this.bundles.get(user.id)!;
  }
}
