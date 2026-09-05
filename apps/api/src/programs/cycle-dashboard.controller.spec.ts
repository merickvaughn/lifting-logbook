import { Test, TestingModule } from '@nestjs/testing';
import { Weekday } from '@lifting-logbook/core';
import { ICycleDashboardRepository } from '../ports/ICycleDashboardRepository';
import { ICycleScheduledWorkoutRepository, ScheduledWorkout } from '../ports/ICycleScheduledWorkoutRepository';
import { ILiftRecordRepository } from '../ports/ILiftRecordRepository';
import { ILiftingProgramSpecRepository } from '../ports/ILiftingProgramSpecRepository';
import { IWorkoutDateOverrideRepository } from '../ports/IWorkoutDateOverrideRepository';
import { IWorkoutSkipOverrideRepository } from '../ports/IWorkoutSkipOverrideRepository';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CycleDashboardController } from './cycle-dashboard.controller';
import { CycleGenerationService } from './cycle-generation.service';

const MOCK_USER = { id: 'test-user', email: 'test@example.com', provider: 'dev' };

const stubDashboard = () => ({
  program: '5-3-1',
  cycleUnit: 'week' as const,
  cycleNum: 2,
  cycleDate: new Date('2026-04-20T00:00:00.000Z'),
  sheetName: '',
  cycleStartWeekday: Weekday.Monday,
});

const stubSpec = (weekType: 'training' | 'test' | 'deload' = 'training') => [{
  week: 1,
  offset: 0,
  lift: 'Squat' as const,
  increment: 5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: '40,50,60',
  wtDecrementPct: 0,
  activation: 'None',
  weekType,
}];

const stubScheduled = (): ScheduledWorkout[] => [
  { workoutNum: 1, weekNum: 1, scheduledDate: new Date('2026-04-21T00:00:00.000Z') },
  { workoutNum: 2, weekNum: 1, scheduledDate: new Date('2026-04-23T00:00:00.000Z') },
  { workoutNum: 3, weekNum: 2, scheduledDate: new Date('2026-04-28T00:00:00.000Z') },
];

describe('CycleDashboardController', () => {
  let controller: CycleDashboardController;
  let repo: jest.Mocked<ICycleDashboardRepository>;
  let specRepo: jest.Mocked<ILiftingProgramSpecRepository>;
  let scheduledRepo: jest.Mocked<ICycleScheduledWorkoutRepository>;
  let liftRecordRepo: jest.Mocked<ILiftRecordRepository>;
  let overrideRepo: jest.Mocked<IWorkoutDateOverrideRepository>;
  let skipRepo: jest.Mocked<IWorkoutSkipOverrideRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;
  let cycleGenerationService: jest.Mocked<Pick<CycleGenerationService, 'deleteCurrentCycle'>>;

  beforeEach(async () => {
    repo = {
      getCycleDashboard: jest.fn(),
      saveCycleDashboard: jest.fn(),
      deleteCycleDashboard: jest.fn(),
    };
    specRepo = { getProgramSpec: jest.fn(), saveProgramSpec: jest.fn(), deleteSpecRows: jest.fn() };
    scheduledRepo = {
      getScheduledWorkouts: jest.fn().mockResolvedValue([]),
      saveScheduledWorkouts: jest.fn(),
    };
    liftRecordRepo = {
      getLiftRecords: jest.fn().mockResolvedValue([]),
      getLoggedWorkoutNums: jest.fn().mockResolvedValue(new Set<number>()),
      appendLiftRecords: jest.fn(),
      findExistingRecords: jest.fn(),
      updateLiftRecord: jest.fn(),
      deleteLiftRecordsByNaturalKeys: jest.fn(),
    };
    overrideRepo = {
      getOverride: jest.fn().mockResolvedValue(null),
      getOverridesForCycle: jest.fn().mockResolvedValue(new Map()),
      upsertOverride: jest.fn(),
    };
    skipRepo = {
      getSkipsForCycle: jest.fn().mockResolvedValue(new Set<number>()),
      skipWorkout: jest.fn(),
      unskipWorkout: jest.fn(),
    };
    factory = {
      forUser: jest.fn().mockResolvedValue({
        cycleDashboard: repo,
        cycleScheduledWorkout: scheduledRepo,
        liftingProgramSpec: specRepo,
        liftRecord: liftRecordRepo,
        workoutDateOverride: overrideRepo,
        workoutSkipOverride: skipRepo,
      }),
    };
    cycleGenerationService = { deleteCurrentCycle: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CycleDashboardController],
      providers: [
        { provide: REPOSITORY_FACTORY, useValue: factory },
        { provide: CycleGenerationService, useValue: cycleGenerationService },
      ],
    }).compile();
    controller = module.get(CycleDashboardController);
  });

  it('GET /programs/:program/cycles/current returns mapped dashboard with derived weekType', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard());
    specRepo.getProgramSpec.mockResolvedValue(stubSpec('training'));

    const result = await controller.getCurrentCycle('5-3-1', MOCK_USER);

    expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
    expect(repo.getCycleDashboard).toHaveBeenCalledWith('5-3-1');
    expect(specRepo.getProgramSpec).toHaveBeenCalledWith('5-3-1');
    expect(result).toEqual({
      program: '5-3-1',
      cycleNum: 2,
      cycleStartDate: '2026-04-20',
      weeks: [],
      currentWeekType: 'training',
      dateOverrides: {},
      skippedWorkoutNums: [],
      completedWorkoutNums: [],
    });
  });

  it('reflects test weekType when program spec contains a test week', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard());
    specRepo.getProgramSpec.mockResolvedValue(stubSpec('test'));

    const result = await controller.getCurrentCycle('5-3-1', MOCK_USER);

    expect(result.currentWeekType).toBe('test');
  });

  it('returns weeks:[] when no scheduled workouts exist (no-schedule mode)', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard());
    specRepo.getProgramSpec.mockResolvedValue(stubSpec());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue([]);

    const result = await controller.getCurrentCycle('5-3-1', MOCK_USER);

    expect(result.weeks).toEqual([]);
  });

  it('returns populated weeks when scheduled workouts exist', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard());
    specRepo.getProgramSpec.mockResolvedValue(stubSpec());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue(stubScheduled());

    const result = await controller.getCurrentCycle('5-3-1', MOCK_USER);

    expect(result.weeks).toHaveLength(2);
    expect(result.weeks[0]).toEqual({
      week: 1,
      workouts: [
        { workoutNum: 1, date: '2026-04-21', skipped: false },
        { workoutNum: 2, date: '2026-04-23', skipped: false },
      ],
      completed: false,
    });
    expect(result.weeks[1]).toEqual({
      week: 2,
      workouts: [{ workoutNum: 3, date: '2026-04-28', skipped: false }],
      completed: false,
    });
  });

  it('uses override date instead of scheduled date when override exists', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard());
    specRepo.getProgramSpec.mockResolvedValue(stubSpec());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue([
      { workoutNum: 1, weekNum: 1, scheduledDate: new Date('2026-04-21T00:00:00.000Z') },
    ]);
    overrideRepo.getOverridesForCycle.mockResolvedValue(new Map([[1, new Date('2026-04-25T00:00:00.000Z')]]));

    const result = await controller.getCurrentCycle('5-3-1', MOCK_USER);

    expect(result.weeks[0]?.workouts).toEqual([{ workoutNum: 1, date: '2026-04-25', skipped: false }]);
  });

  it('marks a week as completed when all its workouts have lift records', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard());
    specRepo.getProgramSpec.mockResolvedValue(stubSpec());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue([
      { workoutNum: 1, weekNum: 1, scheduledDate: new Date('2026-04-21T00:00:00.000Z') },
      { workoutNum: 2, weekNum: 1, scheduledDate: new Date('2026-04-23T00:00:00.000Z') },
    ]);
    liftRecordRepo.getLoggedWorkoutNums.mockResolvedValue(new Set([1, 2]));

    const result = await controller.getCurrentCycle('5-3-1', MOCK_USER);

    expect(result.weeks[0]?.completed).toBe(true);
  });

  it('marks a week as not completed when only some workouts have lift records', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard());
    specRepo.getProgramSpec.mockResolvedValue(stubSpec());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue([
      { workoutNum: 1, weekNum: 1, scheduledDate: new Date('2026-04-21T00:00:00.000Z') },
      { workoutNum: 2, weekNum: 1, scheduledDate: new Date('2026-04-23T00:00:00.000Z') },
    ]);
    liftRecordRepo.getLoggedWorkoutNums.mockResolvedValue(new Set([1]));

    const result = await controller.getCurrentCycle('5-3-1', MOCK_USER);

    expect(result.weeks[0]?.completed).toBe(false);
  });

  it('surfaces per-workout metadata top-level in no-schedule mode (issue #740)', async () => {
    // In no-schedule mode weeks is empty, so the Cycle Dashboard reads these
    // top-level maps to render every tiled workout's status without a per-workout
    // fetch. Verify they are populated from the bulk override/skip/record sources.
    repo.getCycleDashboard.mockResolvedValue(stubDashboard());
    specRepo.getProgramSpec.mockResolvedValue(stubSpec());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue([]);
    overrideRepo.getOverridesForCycle.mockResolvedValue(
      new Map([[2, new Date('2026-04-30T00:00:00.000Z')]]),
    );
    skipRepo.getSkipsForCycle.mockResolvedValue(new Set([3]));
    liftRecordRepo.getLoggedWorkoutNums.mockResolvedValue(new Set([1]));

    const result = await controller.getCurrentCycle('5-3-1', MOCK_USER);

    expect(result.weeks).toEqual([]);
    expect(result.dateOverrides).toEqual({ 2: '2026-04-30' });
    expect(result.skippedWorkoutNums).toEqual([3]);
    expect(result.completedWorkoutNums).toEqual([1]);
  });

  it('DELETE /programs/:program/cycles/current calls service.deleteCurrentCycle with repos and program', async () => {
    await controller.deleteCurrentCycle('5-3-1', MOCK_USER);

    expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
    expect(cycleGenerationService.deleteCurrentCycle).toHaveBeenCalledWith(
      expect.objectContaining({ cycleDashboard: repo }),
      '5-3-1',
    );
  });
});
