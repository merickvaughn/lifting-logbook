import { Logger } from '@nestjs/common';
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

const stubDashboard = (program = '5-3-1') => ({
  program,
  cycleUnit: 'week' as const,
  cycleNum: 2,
  cycleDate: new Date('2026-04-20T00:00:00.000Z'),
  sheetName: '',
  cycleStartWeekday: Weekday.Monday,
});

// Two days a week (offsets 0 and 2) for `weeks` weeks.
const stubSpec = (weekType: 'training' | 'test' | 'deload' = 'training', weeks = 1) =>
  Array.from({ length: weeks }, (_, i) => i + 1).flatMap((week) =>
    [
      { offset: 0, lift: 'Squat' as const },
      { offset: 2, lift: 'Bench Press' as const },
    ].map(({ offset, lift }) => ({
      week,
      offset,
      lift,
      increment: 5,
      order: 1,
      sets: 3,
      reps: 5,
      amrap: false,
      warmUpPct: '40,50,60',
      wtDecrementPct: 0,
      activation: 'None',
      weekType,
    })),
  );

// Schedule-mode tests use an unregistered program, which runs its own spec once:
// with SCHEDULED_SPEC, exactly four workouts — 1–2 in week 1, 3–4 in week 2 — so a
// fixture, not a registry length, decides where the program ends.
const SCHEDULED_PROGRAM = 'my-program';
const SCHEDULED_SPEC = () => stubSpec('training', 2);

const stubScheduled = (): ScheduledWorkout[] => [
  { workoutNum: 1, weekNum: 1, scheduledDate: new Date('2026-04-21T00:00:00.000Z') },
  { workoutNum: 2, weekNum: 1, scheduledDate: new Date('2026-04-23T00:00:00.000Z') },
  { workoutNum: 3, weekNum: 2, scheduledDate: new Date('2026-04-28T00:00:00.000Z') },
  { workoutNum: 4, weekNum: 2, scheduledDate: new Date('2026-04-30T00:00:00.000Z') },
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
    repo.getCycleDashboard.mockResolvedValue(stubDashboard(SCHEDULED_PROGRAM));
    specRepo.getProgramSpec.mockResolvedValue(SCHEDULED_SPEC());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue(stubScheduled());
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const result = await controller.getCurrentCycle(SCHEDULED_PROGRAM, MOCK_USER);

      expect(result.weeks).toEqual([
        {
          week: 1,
          workouts: [
            { workoutNum: 1, date: '2026-04-21', skipped: false },
            { workoutNum: 2, date: '2026-04-23', skipped: false },
          ],
          completed: false,
        },
        {
          week: 2,
          workouts: [
            { workoutNum: 3, date: '2026-04-28', skipped: false },
            { workoutNum: 4, date: '2026-04-30', skipped: false },
          ],
          completed: false,
        },
      ]);
      // Every row is a program day, so nothing is left off and nothing is logged.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('lists a workout under its program week, not the week stored on its row (issue #1023)', async () => {
    // Rows saved before #1023 numbered a Mon/Wed/Fri schedule by calendar week:
    // three workouts in stored week 1 for a program training two days a week.
    // The grid and the workout endpoint show workout 3 in program week 2, so the
    // dashboard (and the plan page's phases, which read it) must too. Rows 5 and
    // 6 are past this four-workout program's last day: they date no workout, so
    // they are left out, with one structured warning for the cycle.
    repo.getCycleDashboard.mockResolvedValue(stubDashboard(SCHEDULED_PROGRAM));
    specRepo.getProgramSpec.mockResolvedValue(SCHEDULED_SPEC());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue([
      { workoutNum: 1, weekNum: 1, scheduledDate: new Date('2026-04-20T00:00:00.000Z') },
      { workoutNum: 2, weekNum: 1, scheduledDate: new Date('2026-04-22T00:00:00.000Z') },
      { workoutNum: 3, weekNum: 1, scheduledDate: new Date('2026-04-24T00:00:00.000Z') },
      { workoutNum: 4, weekNum: 2, scheduledDate: new Date('2026-04-27T00:00:00.000Z') },
      { workoutNum: 5, weekNum: 2, scheduledDate: new Date('2026-04-29T00:00:00.000Z') },
      { workoutNum: 6, weekNum: 2, scheduledDate: new Date('2026-05-01T00:00:00.000Z') },
    ]);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const result = await controller.getCurrentCycle(SCHEDULED_PROGRAM, MOCK_USER);

      expect(result.weeks.map((w) => [w.week, w.workouts.map((ws) => ws.workoutNum)])).toEqual([
        [1, [1, 2]],
        [2, [3, 4]],
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        { program: SCHEDULED_PROGRAM, cycleNum: 2, pastLastDay: 2, unscheduledDays: 0 },
        expect.stringContaining('do not match the program days'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('lists a program day with no scheduled row on its spec-relative date, and warns (issue #1023)', async () => {
    // Rows saved before #1023 for a schedule training fewer days a week than the
    // program dated too few workouts. The days they missed still belong to their
    // program week, so the plan page's phases can complete.
    repo.getCycleDashboard.mockResolvedValue(stubDashboard(SCHEDULED_PROGRAM));
    specRepo.getProgramSpec.mockResolvedValue(SCHEDULED_SPEC());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue(stubScheduled().slice(0, 2));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const result = await controller.getCurrentCycle(SCHEDULED_PROGRAM, MOCK_USER);

      // Cycle start 2026-04-20 + (week-1)*7 + offset.
      expect(result.weeks[1]?.workouts).toEqual([
        { workoutNum: 3, date: '2026-04-27', skipped: false },
        { workoutNum: 4, date: '2026-04-29', skipped: false },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        { program: SCHEDULED_PROGRAM, cycleNum: 2, pastLastDay: 0, unscheduledDays: 2 },
        expect.stringContaining('do not match the program days'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses override date instead of scheduled date when override exists', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard(SCHEDULED_PROGRAM));
    specRepo.getProgramSpec.mockResolvedValue(SCHEDULED_SPEC());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue(stubScheduled());
    overrideRepo.getOverridesForCycle.mockResolvedValue(new Map([[1, new Date('2026-04-25T00:00:00.000Z')]]));

    const result = await controller.getCurrentCycle(SCHEDULED_PROGRAM, MOCK_USER);

    expect(result.weeks[0]?.workouts[0]).toEqual({ workoutNum: 1, date: '2026-04-25', skipped: false });
  });

  it('marks a week as completed when all its workouts have lift records', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard(SCHEDULED_PROGRAM));
    specRepo.getProgramSpec.mockResolvedValue(SCHEDULED_SPEC());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue(stubScheduled());
    liftRecordRepo.getLoggedWorkoutNums.mockResolvedValue(new Set([1, 2]));

    const result = await controller.getCurrentCycle(SCHEDULED_PROGRAM, MOCK_USER);

    expect(result.weeks.map((w) => w.completed)).toEqual([true, false]);
  });

  it('marks a week as not completed when only some workouts have lift records', async () => {
    repo.getCycleDashboard.mockResolvedValue(stubDashboard(SCHEDULED_PROGRAM));
    specRepo.getProgramSpec.mockResolvedValue(SCHEDULED_SPEC());
    scheduledRepo.getScheduledWorkouts.mockResolvedValue(stubScheduled());
    liftRecordRepo.getLoggedWorkoutNums.mockResolvedValue(new Set([1]));

    const result = await controller.getCurrentCycle(SCHEDULED_PROGRAM, MOCK_USER);

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
