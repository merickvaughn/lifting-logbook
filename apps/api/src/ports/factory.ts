import { AuthUser } from './auth';
import { IBodyWeightRepository } from './IBodyWeightRepository';
import { ICustomLiftRepository } from './ICustomLiftRepository';
import { ICycleDashboardRepository } from './ICycleDashboardRepository';
import { ICycleScheduledWorkoutRepository } from './ICycleScheduledWorkoutRepository';
import { IImportBatchRepository } from './IImportBatchRepository';
import { ILiftMetadataRepository } from './ILiftMetadataRepository';
import { ILiftingProgramSpecRepository } from './ILiftingProgramSpecRepository';
import { ILiftRecordRepository } from './ILiftRecordRepository';
import { IProgramPhilosophyRepository } from './IProgramPhilosophyRepository';
import { IStrengthGoalRepository } from './IStrengthGoalRepository';
import { ITrainingMaxHistoryRepository } from './ITrainingMaxHistoryRepository';
import { ITrainingMaxRepository } from './ITrainingMaxRepository';
import { IUserSettingsRepository } from './IUserSettingsRepository';
import { IWorkoutDateOverrideRepository } from './IWorkoutDateOverrideRepository';
import { IWorkoutLiftOverrideRepository } from './IWorkoutLiftOverrideRepository';
import { IWorkoutRepository } from './IWorkoutRepository';
import { IWorkoutSkipOverrideRepository } from './IWorkoutSkipOverrideRepository';

export interface RepositoryBundle {
  bodyWeight: IBodyWeightRepository;
  customLift: ICustomLiftRepository;
  cycleDashboard: ICycleDashboardRepository;
  cycleScheduledWorkout: ICycleScheduledWorkoutRepository;
  importBatch: IImportBatchRepository;
  liftMetadata: ILiftMetadataRepository;
  liftingProgramSpec: ILiftingProgramSpecRepository;
  liftRecord: ILiftRecordRepository;
  programPhilosophy: IProgramPhilosophyRepository;
  strengthGoal: IStrengthGoalRepository;
  trainingMax: ITrainingMaxRepository;
  trainingMaxHistory: ITrainingMaxHistoryRepository;
  userSettings: IUserSettingsRepository;
  workout: IWorkoutRepository;
  workoutDateOverride: IWorkoutDateOverrideRepository;
  workoutLiftOverride: IWorkoutLiftOverrideRepository;
  workoutSkipOverride: IWorkoutSkipOverrideRepository;
}

export interface IRepositoryFactory {
  forUser(user: AuthUser): Promise<RepositoryBundle>;
}
