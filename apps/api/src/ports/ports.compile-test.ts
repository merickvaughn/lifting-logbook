/**
 * Compile-time contract tests for port interfaces.
 *
 * Each test assigns a mock object literal directly to the interface type.
 * If the mock is missing a required method or uses an incompatible signature,
 * the TypeScript compiler will error here — no runtime needed.
 */
import { CycleDashboard, LiftRecord, LiftingProgramSpec, TrainingMax, TrainingMaxHistoryEntry } from '@lifting-logbook/core';
import { BodyWeightEntry } from '@lifting-logbook/types';
import { AuthUser, IAuthProvider } from './auth';
import { IBodyWeightRepository } from './IBodyWeightRepository';
import { IRepositoryFactory, RepositoryBundle } from './factory';
import { ICustomLiftRepository } from './ICustomLiftRepository';
import { ICycleDashboardRepository } from './ICycleDashboardRepository';
import { ICycleScheduledWorkoutRepository } from './ICycleScheduledWorkoutRepository';
import { ILiftingProgramSpecRepository } from './ILiftingProgramSpecRepository';
import { ILiftRecordRepository } from './ILiftRecordRepository';
import { IProgramPhilosophyRepository } from './IProgramPhilosophyRepository';
import { ITrainingMaxRepository } from './ITrainingMaxRepository';
import { ITrainingMaxHistoryRepository } from './ITrainingMaxHistoryRepository';
import { ILiftMetadataRepository } from './ILiftMetadataRepository';
import { IStrengthGoalRepository } from './IStrengthGoalRepository';
import { IUserSettingsRepository } from './IUserSettingsRepository';
import { IWorkoutDateOverrideRepository } from './IWorkoutDateOverrideRepository';
import { IWorkoutLiftOverrideRepository } from './IWorkoutLiftOverrideRepository';
import { IWorkoutRepository } from './IWorkoutRepository';
import { IWorkoutSkipOverrideRepository } from './IWorkoutSkipOverrideRepository';
import { IImportBatchRepository } from './IImportBatchRepository';

// ---------------------------------------------------------------------------
// IAuthProvider
// ---------------------------------------------------------------------------

const _authProvider: IAuthProvider = {
  verifyToken: (): Promise<AuthUser> =>
    Promise.resolve({ id: '1', email: 'test@example.com', provider: 'clerk' }),
};

// ---------------------------------------------------------------------------
// ICycleDashboardRepository
// ---------------------------------------------------------------------------

const _cycleDashboardRepo: ICycleDashboardRepository = {
  getCycleDashboard: (): Promise<CycleDashboard> =>
    Promise.resolve({} as CycleDashboard),
  saveCycleDashboard: (): Promise<void> =>
    Promise.resolve(),
  deleteCycleDashboard: (): Promise<void> =>
    Promise.resolve(),
};

// ---------------------------------------------------------------------------
// ILiftingProgramSpecRepository
// ---------------------------------------------------------------------------

const _programSpecRepo: ILiftingProgramSpecRepository = {
  getProgramSpec: (): Promise<LiftingProgramSpec[]> =>
    Promise.resolve([]),
  saveProgramSpec: () =>
    Promise.resolve({ created: 0, updated: 0, skipped: 0 }),
  deleteSpecRows: (): Promise<void> =>
    Promise.resolve(),
};

// ---------------------------------------------------------------------------
// ILiftRecordRepository
// ---------------------------------------------------------------------------

const _liftRecordRepo: ILiftRecordRepository = {
  getLiftRecords: (): Promise<LiftRecord[]> =>
    Promise.resolve([]),
  appendLiftRecords: (): Promise<number> =>
    Promise.resolve(0),
  findExistingRecords: (): Promise<LiftRecord[]> =>
    Promise.resolve([]),
  updateLiftRecord: (): Promise<LiftRecord | null> =>
    Promise.resolve(null),
  deleteLiftRecordsByNaturalKeys: (): Promise<number> =>
    Promise.resolve(0),
  deleteAllLiftRecords: (): Promise<void> =>
    Promise.resolve(),
};

// ---------------------------------------------------------------------------
// IBodyWeightRepository
// ---------------------------------------------------------------------------

const _bodyWeightRepo: IBodyWeightRepository = {
  recordBodyWeight: (): Promise<void> =>
    Promise.resolve(),
  getLatestBodyWeight: (): Promise<BodyWeightEntry | null> =>
    Promise.resolve(null),
};

// ---------------------------------------------------------------------------
// ITrainingMaxRepository
// ---------------------------------------------------------------------------

const _trainingMaxRepo: ITrainingMaxRepository = {
  getTrainingMaxes: (): Promise<TrainingMax[]> =>
    Promise.resolve([]),
  saveTrainingMaxes: (): Promise<void> =>
    Promise.resolve(),
  importTrainingMaxes: () =>
    Promise.resolve({ created: 0, updated: 0, skipped: 0 }),
  deleteTrainingMaxes: (): Promise<void> =>
    Promise.resolve(),
  deleteAllTrainingMaxes: (): Promise<void> =>
    Promise.resolve(),
};

// ---------------------------------------------------------------------------
// ITrainingMaxHistoryRepository
// ---------------------------------------------------------------------------

const _trainingMaxHistoryRepo: ITrainingMaxHistoryRepository = {
  getHistory: (): Promise<TrainingMaxHistoryEntry[]> => Promise.resolve([]),
  appendHistoryEntries: (): Promise<void> => Promise.resolve(),
  updateHistoryEntry: (): Promise<TrainingMaxHistoryEntry> =>
    Promise.resolve({ id: '', lift: '', weight: 0, reps: 1, date: new Date(), isPR: false, source: 'program', goalMet: false }),
  deleteAllHistory: (): Promise<void> => Promise.resolve(),
};

// IWorkoutRepository
// ---------------------------------------------------------------------------

const _workoutRepo: IWorkoutRepository = {
  getWorkout: (): Promise<LiftRecord[]> =>
    Promise.resolve([]),
  saveWorkout: (): Promise<void> =>
    Promise.resolve(),
};

// ---------------------------------------------------------------------------
// IRepositoryFactory
// ---------------------------------------------------------------------------

const _programPhilosophyRepo: IProgramPhilosophyRepository = {
  getProgramPhilosophy: () => Promise.resolve(null),
  listPrograms: () => Promise.resolve([]),
};

const _workoutDateOverrideRepo: IWorkoutDateOverrideRepository = {
  getOverride: () => Promise.resolve(null),
  getOverridesForCycle: () => Promise.resolve(new Map()),
  upsertOverride: () => Promise.resolve(),
};

const _liftMetadataRepo: ILiftMetadataRepository = {
  getMetadata: () => Promise.resolve(null),
  upsertMetadata: (_lift, _patch) =>
    Promise.resolve({ lift: '', muscleGroups: [], substitutions: [], foundational: false }),
};

const _strengthGoalRepo: IStrengthGoalRepository = {
  getGoals: () => Promise.resolve([]),
  upsertGoal: (_program, goal) => Promise.resolve(goal),
  deleteGoal: () => Promise.resolve(),
  importGoals: () => Promise.resolve({ created: 0, updated: 0, skipped: 0 }),
};

const _workoutLiftOverrideRepo: IWorkoutLiftOverrideRepository = {
  getOverrides: () => Promise.resolve([]),
  upsertOverride: () => Promise.resolve(),
  deleteOverride: () => Promise.resolve(),
};

const _cycleScheduledWorkoutRepo: ICycleScheduledWorkoutRepository = {
  getScheduledWorkouts: () => Promise.resolve([]),
  saveScheduledWorkouts: () => Promise.resolve(),
};

const _workoutSkipOverrideRepo: IWorkoutSkipOverrideRepository = {
  getSkipsForCycle: () => Promise.resolve(new Set<number>()),
  skipWorkout: () => Promise.resolve(),
  unskipWorkout: () => Promise.resolve(),
};

const _userSettingsRepo: IUserSettingsRepository = {
  getSettings: () =>
    Promise.resolve({ activeProgram: null, workoutSchedule: null, defaultWeightIncrement: null, unit: null }),
};

const _customLiftRepo: ICustomLiftRepository = {
  list: () => Promise.resolve([]),
  create: (input) =>
    Promise.resolve({
      id: '',
      userId: '',
      name: input.name,
      classification: input.classification,
      movementProfile: input.movementProfile ?? { patterns: [], jointActions: [], complexity: 'simple' },
      isBodyweightComponent: input.isBodyweightComponent ?? false,
      isCustom: true,
      createdAt: new Date(),
    }),
  update: (id, _patch) =>
    Promise.resolve({
      id,
      userId: '',
      name: '',
      classification: 'compound',
      movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
      isBodyweightComponent: false,
      isCustom: true,
      createdAt: new Date(),
    }),
  delete: () => Promise.resolve(),
};

const _importBatchRepo: IImportBatchRepository = {
  save: (): Promise<void> => Promise.resolve(),
  findById: () => Promise.resolve(null),
  deleteById: (): Promise<void> => Promise.resolve(),
};

const _repositoryBundle: RepositoryBundle = {
  bodyWeight: _bodyWeightRepo,
  customLift: _customLiftRepo,
  cycleDashboard: _cycleDashboardRepo,
  cycleScheduledWorkout: _cycleScheduledWorkoutRepo,
  liftMetadata: _liftMetadataRepo,
  liftingProgramSpec: _programSpecRepo,
  liftRecord: _liftRecordRepo,
  programPhilosophy: _programPhilosophyRepo,
  strengthGoal: _strengthGoalRepo,
  trainingMax: _trainingMaxRepo,
  trainingMaxHistory: _trainingMaxHistoryRepo,
  userSettings: _userSettingsRepo,
  workout: _workoutRepo,
  workoutDateOverride: _workoutDateOverrideRepo,
  workoutLiftOverride: _workoutLiftOverrideRepo,
  workoutSkipOverride: _workoutSkipOverrideRepo,
  importBatch: _importBatchRepo,
};

const _repositoryFactory: IRepositoryFactory = {
  forUser: (): Promise<RepositoryBundle> => Promise.resolve(_repositoryBundle),
};

// Suppress "declared but never read" errors — these variables exist solely
// to trigger structural type checking at compile time.
void _authProvider;
void _cycleDashboardRepo;
void _programSpecRepo;
void _liftRecordRepo;
void _trainingMaxRepo;
void _trainingMaxHistoryRepo;
void _workoutRepo;
void _liftMetadataRepo;
void _strengthGoalRepo;
void _workoutDateOverrideRepo;
void _workoutLiftOverrideRepo;
void _cycleScheduledWorkoutRepo;
void _userSettingsRepo;
void _repositoryBundle;
void _repositoryFactory;
