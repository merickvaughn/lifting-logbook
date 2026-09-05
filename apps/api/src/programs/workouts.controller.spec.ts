import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Weekday } from '@lifting-logbook/core';
import { ICycleDashboardRepository } from '../ports/ICycleDashboardRepository';
import { ICycleScheduledWorkoutRepository } from '../ports/ICycleScheduledWorkoutRepository';
import { ILiftingProgramSpecRepository } from '../ports/ILiftingProgramSpecRepository';
import { IWorkoutDateOverrideRepository } from '../ports/IWorkoutDateOverrideRepository';
import { IWorkoutLiftOverrideRepository } from '../ports/IWorkoutLiftOverrideRepository';
import { IWorkoutRepository } from '../ports/IWorkoutRepository';
import { IWorkoutSkipOverrideRepository } from '../ports/IWorkoutSkipOverrideRepository';
import { ProgramNotFoundError, WorkoutNotFoundError } from '../ports/errors';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { WorkoutsController } from './workouts.controller';

const MOCK_USER = { id: 'test-user', email: 'test@example.com', provider: 'dev' };

describe('WorkoutsController', () => {
  let controller: WorkoutsController;
  let workoutRepo: jest.Mocked<IWorkoutRepository>;
  let dashboardRepo: jest.Mocked<ICycleDashboardRepository>;
  let specRepo: jest.Mocked<ILiftingProgramSpecRepository>;
  let overrideRepo: jest.Mocked<IWorkoutDateOverrideRepository>;
  let liftOverrideRepo: jest.Mocked<IWorkoutLiftOverrideRepository>;
  let scheduledWorkoutRepo: jest.Mocked<ICycleScheduledWorkoutRepository>;
  let skipOverrideRepo: jest.Mocked<IWorkoutSkipOverrideRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;

  beforeEach(async () => {
    workoutRepo = { getWorkout: jest.fn(), saveWorkout: jest.fn() };
    dashboardRepo = {
      getCycleDashboard: jest.fn(),
      saveCycleDashboard: jest.fn(),
    };
    specRepo = { getProgramSpec: jest.fn(), saveProgramSpec: jest.fn(), deleteSpecRows: jest.fn() };
    overrideRepo = {
      getOverride: jest.fn().mockResolvedValue(null),
      upsertOverride: jest.fn().mockResolvedValue(undefined),
    };
    liftOverrideRepo = {
      getOverrides: jest.fn().mockResolvedValue([]),
      upsertOverride: jest.fn().mockResolvedValue(undefined),
      deleteOverride: jest.fn().mockResolvedValue(undefined),
    };
    scheduledWorkoutRepo = {
      getScheduledWorkouts: jest.fn().mockResolvedValue([]),
      saveScheduledWorkouts: jest.fn().mockResolvedValue(undefined),
    };
    skipOverrideRepo = {
      getSkipsForCycle: jest.fn().mockResolvedValue(new Set<number>()),
      skipWorkout: jest.fn().mockResolvedValue(undefined),
      unskipWorkout: jest.fn().mockResolvedValue(undefined),
    };
    factory = {
      forUser: jest.fn().mockResolvedValue({
        workout: workoutRepo,
        cycleDashboard: dashboardRepo,
        cycleScheduledWorkout: scheduledWorkoutRepo,
        liftingProgramSpec: specRepo,
        workoutDateOverride: overrideRepo,
        workoutLiftOverride: liftOverrideRepo,
        workoutSkipOverride: skipOverrideRepo,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkoutsController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(WorkoutsController);
  });

  it('groups records by lift, sources week from spec, and looks up current cycle', async () => {
    dashboardRepo.getCycleDashboard.mockResolvedValue({
      program: '5-3-1',
      cycleUnit: 'week',
      cycleNum: 3,
      cycleDate: new Date('2026-04-20T00:00:00.000Z'),
      sheetName: '',
      cycleStartWeekday: Weekday.Monday,
    });
    specRepo.getProgramSpec.mockResolvedValue([
      {
        week: 1,
        offset: 0,
        lift: 'Squat',
        increment: 5,
        order: 1,
        sets: 3,
        reps: 5,
        amrap: true,
        warmUpPct: '0.4,0.5,0.6',
        wtDecrementPct: 0.1,
        activation: 'compound',
      },
    ]);
    workoutRepo.getWorkout.mockResolvedValue([
      {
        program: '5-3-1',
        cycleNum: 3,
        workoutNum: 1,
        date: new Date('2026-04-20T00:00:00.000Z'),
        lift: 'Squat',
        setNum: 1,
        weight: 200,
        reps: 5,
        notes: '',
      },
      {
        program: '5-3-1',
        cycleNum: 3,
        workoutNum: 1,
        date: new Date('2026-04-20T00:00:00.000Z'),
        lift: 'Squat',
        setNum: 2,
        weight: 220,
        reps: 5,
        notes: 'AMRAP',
      },
    ]);

    const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

    expect(workoutRepo.getWorkout).toHaveBeenCalledWith('5-3-1', 3, 1);
    expect(result.cycleNum).toBe(3);
    expect(result.week).toBe(1);
    expect(result.lifts).toHaveLength(1);
    expect(result.lifts[0]?.lift).toBe('Squat');
    expect(result.lifts[0]?.planned).toBe(false);
    expect(result.lifts[0]?.sets).toEqual([
      { id: '5-3-1-3-1-20260420-Squat-1', setNum: 1, weight: 200, reps: 5, amrap: false, notes: '' },
      { id: '5-3-1-3-1-20260420-Squat-2', setNum: 2, weight: 220, reps: 5, amrap: true, notes: 'AMRAP' },
    ]);
  });

  it('keeps each set id addressed to the stored row under a replace override (issue #978)', async () => {
    dashboardRepo.getCycleDashboard.mockResolvedValue({ cycleNum: 3, cycleDate: new Date('2026-04-20T00:00:00.000Z') });
    specRepo.getProgramSpec.mockResolvedValue([
      { week: 1, offset: 0, lift: 'Squat', increment: 5, order: 1, sets: 3, reps: 5, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
    ]);
    workoutRepo.getWorkout.mockResolvedValue([
      {
        program: '5-3-1',
        cycleNum: 3,
        workoutNum: 1,
        date: new Date('2026-04-20T00:00:00.000Z'),
        lift: 'Squat',
        setNum: 1,
        weight: 200,
        reps: 5,
        notes: '',
      },
    ]);
    liftOverrideRepo.getOverrides.mockResolvedValue([{ lift: 'Squat', action: 'replace', replacedBy: 'Front Squat' }]);

    const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

    // Grouped under the replacement so the planned list and the logged sets agree…
    expect(result.lifts.map((l) => l.lift)).toEqual(['Front Squat']);
    expect(result.lifts[0]?.planned).toBe(false);
    // …but the row is still persisted as Squat, so that is the id PATCH must address.
    expect(result.lifts[0]?.sets[0]?.id).toBe('5-3-1-3-1-20260420-Squat-1');
  });

  it('returns 400 only when workoutNum exceeds the full canonical length, not one block (issue #740)', async () => {
    // Leangains tiles a 1-week / 3-offset block across 12 weeks = 36 workout days.
    // Pre-#740 the no-schedule cap was 3 (one block); now it is the full 36, so a
    // 400 means the workoutNum is past the whole cycle, not merely past week 1.
    specRepo.getProgramSpec.mockResolvedValue([
      { week: 1, offset: 0, lift: 'Bench Press', increment: 5, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
      { week: 1, offset: 2, lift: 'Squat', increment: 10, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
      { week: 1, offset: 4, lift: 'Overhead Press', increment: 5, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
    ]);
    dashboardRepo.getCycleDashboard.mockResolvedValue({
      program: 'leangains',
      cycleUnit: 'week',
      cycleNum: 3,
      cycleDate: new Date('2026-04-20T00:00:00.000Z'),
      sheetName: '',
      cycleStartWeekday: Weekday.Monday,
    });
    workoutRepo.getWorkout.mockResolvedValue([]);

    await expect(controller.getWorkout('leangains', '37', MOCK_USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects non-numeric workoutNum', async () => {
    await expect(controller.getWorkout('5-3-1', 'abc', MOCK_USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('resolves a no-schedule tiled week-2 workout to its program week (issue #740)', async () => {
    // Leangains 1-week block of 2 offsets tiled across 12 weeks; workout 3 lands in
    // week 2. Pre-#740 this 400'd in no-schedule mode — #680 fixed only schedule
    // mode (see the scheduled-row test below). Planned lifts still come from the
    // tiled block week (block week 1 for a 1-week block).
    dashboardRepo.getCycleDashboard.mockResolvedValue({
      program: 'leangains',
      cycleUnit: 'week',
      cycleNum: 3,
      cycleDate: new Date('2026-04-20T00:00:00.000Z'),
      sheetName: '',
      cycleStartWeekday: Weekday.Monday,
    });
    specRepo.getProgramSpec.mockResolvedValue([
      { week: 1, offset: 0, lift: 'Bench Press', increment: 5, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
      { week: 1, offset: 2, lift: 'Squat', increment: 10, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
    ]);
    workoutRepo.getWorkout.mockResolvedValue([]); // upcoming — no records, no schedule

    const result = await controller.getWorkout('leangains', '3', MOCK_USER);

    expect(result.week).toBe(2);
    expect(result.lifts.map((l) => l.lift).sort()).toEqual(['Bench Press', 'Squat']);
    expect(result.lifts.every((l) => l.planned)).toBe(true);
  });

  it('sets the no-schedule detail date to the Cycle Dashboard card date, not today (issue #745)', async () => {
    // Same leangains 2-offset block + cycleStart as the web buildWorkoutDays card
    // test, so this asserts card date == detail date end-to-end. workout 3 → (week 2,
    // offset 0) → cycleStart 2026-04-20 + 7 = 2026-04-27. Pre-#745 the no-schedule,
    // unlogged detail fell back to today() and diverged from the card.
    dashboardRepo.getCycleDashboard.mockResolvedValue({
      program: 'leangains',
      cycleUnit: 'week',
      cycleNum: 3,
      cycleDate: new Date('2026-04-20T00:00:00.000Z'),
      sheetName: '',
      cycleStartWeekday: Weekday.Monday,
    });
    specRepo.getProgramSpec.mockResolvedValue([
      { week: 1, offset: 0, lift: 'Bench Press', increment: 5, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
      { week: 1, offset: 2, lift: 'Squat', increment: 10, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
    ]);
    workoutRepo.getWorkout.mockResolvedValue([]); // upcoming — no records, no schedule

    const result = await controller.getWorkout('leangains', '3', MOCK_USER);

    expect(result.week).toBe(2);
    expect(result.date).toBe('2026-04-27');
  });

  it('resolves week from the scheduled row for a tiled week-2+ workout (issue #680)', async () => {
    // A 12-week Leangains schedule tiles a 1-week block, so workoutNum 4 lands in
    // week 2 — beyond the block's 2 distinct offsets. Without sourcing week from
    // the scheduled row this would 400; planned lifts must still come from the block.
    dashboardRepo.getCycleDashboard.mockResolvedValue({
      program: 'leangains',
      cycleUnit: 'week',
      cycleNum: 1,
      cycleDate: new Date('2026-04-20T00:00:00.000Z'),
      sheetName: '',
      cycleStartWeekday: Weekday.Monday,
    });
    specRepo.getProgramSpec.mockResolvedValue([
      { week: 1, offset: 0, lift: 'Bench Press', increment: 5, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
      { week: 1, offset: 2, lift: 'Squat', increment: 10, order: 1, sets: 3, reps: 6, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0.1, activation: 'compound' },
    ]);
    workoutRepo.getWorkout.mockResolvedValue([]); // upcoming — no records yet
    scheduledWorkoutRepo.getScheduledWorkouts.mockResolvedValue([
      { workoutNum: 1, weekNum: 1, scheduledDate: new Date('2026-04-20T00:00:00.000Z') },
      { workoutNum: 4, weekNum: 2, scheduledDate: new Date('2026-04-27T00:00:00.000Z') },
    ]);

    const result = await controller.getWorkout('leangains', '4', MOCK_USER);

    expect(result.week).toBe(2);
    // Planned lifts come from the tiled block week (block week 1 for a 1-week block).
    expect(result.lifts.map((l) => l.lift).sort()).toEqual(['Bench Press', 'Squat']);
    expect(result.lifts.every((l) => l.planned)).toBe(true);
  });

  describe('overrideDate', () => {
    const baseDashboard = {
      program: '5-3-1',
      cycleUnit: 'week',
      cycleNum: 3,
      cycleDate: new Date('2026-04-20T00:00:00.000Z'),
      sheetName: '',
      cycleStartWeekday: Weekday.Monday,
    };
    const baseSpec = [
      {
        week: 1,
        offset: 0,
        lift: 'Squat',
        increment: 5,
        order: 1,
        sets: 3,
        reps: 5,
        amrap: false,
        warmUpPct: '',
        wtDecrementPct: 0,
        activation: 'compound',
      },
    ];
    const baseRecord = {
      program: '5-3-1',
      cycleNum: 3,
      workoutNum: 1,
      date: new Date('2026-04-20T00:00:00.000Z'),
      lift: 'Squat',
      setNum: 1,
      weight: 200,
      reps: 5,
      notes: '',
    };

    it('includes overrideDate in response when an override exists', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(baseDashboard);
      specRepo.getProgramSpec.mockResolvedValue(baseSpec);
      workoutRepo.getWorkout.mockResolvedValue([baseRecord]);
      overrideRepo.getOverride.mockResolvedValue(new Date('2026-05-01T00:00:00.000Z'));

      const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(result.overrideDate).toBe('2026-05-01');
    });

    it('omits overrideDate when no override exists', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(baseDashboard);
      specRepo.getProgramSpec.mockResolvedValue(baseSpec);
      workoutRepo.getWorkout.mockResolvedValue([baseRecord]);
      overrideRepo.getOverride.mockResolvedValue(null);

      const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(result.overrideDate).toBeUndefined();
    });
  });

  describe('upcoming workouts (no logged records)', () => {
    const dashboard = {
      program: '5-3-1',
      cycleUnit: 'week',
      cycleNum: 3,
      cycleDate: new Date('2026-04-20T00:00:00.000Z'),
      sheetName: '',
      cycleStartWeekday: Weekday.Monday,
    };
    const twoLiftSpec = [
      { week: 1, offset: 0, lift: 'Squat', increment: 5, order: 1, sets: 3, reps: 5, amrap: false, warmUpPct: '', wtDecrementPct: 0, activation: 'compound' },
      { week: 1, offset: 0, lift: 'Bench Press', increment: 5, order: 2, sets: 3, reps: 5, amrap: false, warmUpPct: '', wtDecrementPct: 0, activation: 'compound' },
    ];

    it('returns planned lifts with planned:true and empty sets when workout not yet logged', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(dashboard);
      specRepo.getProgramSpec.mockResolvedValue(twoLiftSpec);
      workoutRepo.getWorkout.mockRejectedValue(new WorkoutNotFoundError('5-3-1', 3, 1));

      const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(result.lifts).toHaveLength(2);
      expect(result.lifts[0]).toMatchObject({ lift: 'Squat', sets: [], planned: true });
      expect(result.lifts[1]).toMatchObject({ lift: 'Bench Press', sets: [], planned: true });
    });

    it('excludes removed lifts from the planned list', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(dashboard);
      specRepo.getProgramSpec.mockResolvedValue(twoLiftSpec);
      workoutRepo.getWorkout.mockRejectedValue(new WorkoutNotFoundError('5-3-1', 3, 1));
      liftOverrideRepo.getOverrides.mockResolvedValue([{ lift: 'Squat', action: 'remove' }]);

      const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(result.lifts.map((l) => l.lift)).toEqual(['Bench Press']);
    });

    it('appends added lifts to the planned list', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(dashboard);
      specRepo.getProgramSpec.mockResolvedValue(twoLiftSpec);
      workoutRepo.getWorkout.mockRejectedValue(new WorkoutNotFoundError('5-3-1', 3, 1));
      liftOverrideRepo.getOverrides.mockResolvedValue([{ lift: 'Deadlift', action: 'add' }]);

      const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(result.lifts.map((l) => l.lift)).toEqual(['Squat', 'Bench Press', 'Deadlift']);
    });

    it('rethrows non-WorkoutNotFoundError errors', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(dashboard);
      specRepo.getProgramSpec.mockResolvedValue(twoLiftSpec);
      workoutRepo.getWorkout.mockRejectedValue(new Error('db connection lost'));

      await expect(controller.getWorkout('5-3-1', '1', MOCK_USER)).rejects.toThrow('db connection lost');
    });

    it('falls back to cycleNum 1 when getCycleDashboard throws ProgramNotFoundError', async () => {
      dashboardRepo.getCycleDashboard.mockRejectedValue(new ProgramNotFoundError('5-3-1'));
      specRepo.getProgramSpec.mockResolvedValue(twoLiftSpec);
      workoutRepo.getWorkout.mockRejectedValue(new WorkoutNotFoundError('5-3-1', 1, 1));

      const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(result.lifts).toHaveLength(2);
      expect(result.lifts[0]).toMatchObject({ lift: 'Squat', planned: true });
    });

    it('rethrows non-ProgramNotFoundError errors from getCycleDashboard', async () => {
      dashboardRepo.getCycleDashboard.mockRejectedValue(new Error('db connection lost'));
      specRepo.getProgramSpec.mockResolvedValue(twoLiftSpec);

      // Assert the controller did NOT narrow this into the ProgramNotFoundError
      // fallback path — if a future refactor broadens the catch, this test fails.
      await expect(controller.getWorkout('5-3-1', '1', MOCK_USER)).rejects.not.toBeInstanceOf(
        ProgramNotFoundError,
      );
      await expect(controller.getWorkout('5-3-1', '1', MOCK_USER)).rejects.toThrow('db connection lost');
    });
  });

  describe('skipped field', () => {
    const dashboard = {
      program: '5-3-1',
      cycleUnit: 'week',
      cycleNum: 3,
      cycleDate: new Date('2026-04-20T00:00:00.000Z'),
      sheetName: '',
      cycleStartWeekday: Weekday.Monday,
    };
    const spec = [
      { week: 1, offset: 0, lift: 'Squat', increment: 5, order: 1, sets: 3, reps: 5, amrap: false, warmUpPct: '', wtDecrementPct: 0, activation: 'compound' },
    ];

    it('returns skipped: false when the workout is not in the skip set', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(dashboard);
      specRepo.getProgramSpec.mockResolvedValue(spec);
      workoutRepo.getWorkout.mockRejectedValue(new WorkoutNotFoundError('5-3-1', 3, 1));
      skipOverrideRepo.getSkipsForCycle.mockResolvedValue(new Set<number>());

      const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(result.skipped).toBe(false);
    });

    it('returns skipped: true when the workout is in the skip set', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(dashboard);
      specRepo.getProgramSpec.mockResolvedValue(spec);
      workoutRepo.getWorkout.mockRejectedValue(new WorkoutNotFoundError('5-3-1', 3, 1));
      skipOverrideRepo.getSkipsForCycle.mockResolvedValue(new Set([1]));

      const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(result.skipped).toBe(true);
    });

    it('fetches skip set for the current cycle', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(dashboard);
      specRepo.getProgramSpec.mockResolvedValue(spec);
      workoutRepo.getWorkout.mockRejectedValue(new WorkoutNotFoundError('5-3-1', 3, 1));
      skipOverrideRepo.getSkipsForCycle.mockResolvedValue(new Set<number>());

      await controller.getWorkout('5-3-1', '1', MOCK_USER);

      expect(skipOverrideRepo.getSkipsForCycle).toHaveBeenCalledWith('5-3-1', 3);
    });

    it('treats getSkipsForCycle failure as empty skip set (does not propagate the error)', async () => {
      // The controller swallows getSkipsForCycle errors and falls back to an
      // empty Set so a transient skip-store failure cannot break the workout
      // response. Verify the fallback branch separately from the success
      // branch — see docs/standards/error-fallback-test-coverage.md.
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        dashboardRepo.getCycleDashboard.mockResolvedValue(dashboard);
        specRepo.getProgramSpec.mockResolvedValue(spec);
        workoutRepo.getWorkout.mockRejectedValue(new WorkoutNotFoundError('5-3-1', 3, 1));
        skipOverrideRepo.getSkipsForCycle.mockRejectedValue(new Error('skip store unavailable'));

        const result = await controller.getWorkout('5-3-1', '1', MOCK_USER);

        expect(result.skipped).toBe(false);
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
