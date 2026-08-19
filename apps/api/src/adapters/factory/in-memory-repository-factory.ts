import { Injectable } from '@nestjs/common';
import { LiftRecord } from '@lifting-logbook/core';
import { AuthUser } from '../../ports/auth';
import { IRepositoryFactory, RepositoryBundle } from '../../ports/factory';
import { InMemoryBodyWeightRepository } from '../in-memory/body-weight.adapter';
import { InMemoryCustomLiftRepository } from '../in-memory/custom-lift.adapter';
import { InMemoryCycleDashboardRepository } from '../in-memory/cycle-dashboard.adapter';
import { InMemoryCycleScheduledWorkoutRepository } from '../in-memory/cycle-scheduled-workout.adapter';
import { InMemoryImportBatchRepository } from '../in-memory/import-batch.adapter';
import { InMemoryLiftMetadataRepository } from '../in-memory/lift-metadata.adapter';
import { InMemoryLiftingProgramSpecRepository } from '../in-memory/lifting-program-spec.adapter';
import { InMemoryLiftRecordRepository } from '../in-memory/lift-record.adapter';
import { InMemoryProgramPhilosophyRepository } from '../in-memory/program-philosophy.adapter';
import { InMemoryStrengthGoalRepository } from '../in-memory/strength-goal.adapter';
import { InMemoryTrainingMaxRepository } from '../in-memory/training-max.adapter';
import { InMemoryTrainingMaxHistoryRepository } from '../in-memory/training-max-history.adapter';
import { InMemoryUserSettingsRepository } from '../in-memory/user-settings.adapter';
import { InMemoryWorkoutDateOverrideRepository } from '../in-memory/workout-date-override.adapter';
import { InMemoryWorkoutLiftOverrideRepository } from '../in-memory/workout-lift-override.adapter';
import { InMemoryWorkoutRepository } from '../in-memory/workout.adapter';
import { InMemoryWorkoutSkipOverrideRepository } from '../in-memory/workout-skip-override.adapter';
import { SEED_PROGRAM, seedLiftRecords } from '../in-memory/fixtures';

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
      this.bundles.set(user.id, {
        bodyWeight: new InMemoryBodyWeightRepository(),
        customLift: new InMemoryCustomLiftRepository(user.id),
        cycleDashboard: new InMemoryCycleDashboardRepository(preSeed),
        cycleScheduledWorkout: new InMemoryCycleScheduledWorkoutRepository(),
        importBatch: new InMemoryImportBatchRepository(),
        liftMetadata: new InMemoryLiftMetadataRepository(),
        liftingProgramSpec: new InMemoryLiftingProgramSpecRepository(preSeed),
        liftRecord: new InMemoryLiftRecordRepository(sharedRecords),
        programPhilosophy: new InMemoryProgramPhilosophyRepository(),
        strengthGoal: new InMemoryStrengthGoalRepository(),
        trainingMax: new InMemoryTrainingMaxRepository(preSeed),
        trainingMaxHistory: new InMemoryTrainingMaxHistoryRepository(),
        userSettings: new InMemoryUserSettingsRepository(),
        workout: new InMemoryWorkoutRepository(sharedRecords),
        workoutDateOverride: new InMemoryWorkoutDateOverrideRepository(),
        workoutLiftOverride: new InMemoryWorkoutLiftOverrideRepository(),
        workoutSkipOverride: new InMemoryWorkoutSkipOverrideRepository(),
      });
    }
    return this.bundles.get(user.id)!;
  }
}
