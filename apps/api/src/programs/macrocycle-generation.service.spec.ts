import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PRESET_BASE_SPECS, Weekday, distributeWorkouts } from '@lifting-logbook/core';
import { DAY_INDEX, UserWorkoutSchedule } from '@lifting-logbook/types';

// distributeWorkouts is wrapped, not replaced: every test calls through to the real
// implementation except the one that makes it break its contract (issue #1023).
jest.mock('@lifting-logbook/core', () => {
  const actual = jest.requireActual<typeof import('@lifting-logbook/core')>('@lifting-logbook/core');
  return { ...actual, distributeWorkouts: jest.fn(actual.distributeWorkouts) };
});
import {
  IMacrocycleDashboardRepository,
  ILiftRecordRepository,
  ILiftingProgramSpecRepository,
  ITrainingMaxHistoryRepository,
  ITrainingMaxRepository,
} from '../ports';
import { IMacrocycleScheduledWorkoutRepository } from '../ports/IMacrocycleScheduledWorkoutRepository';
import { IUserSettingsRepository } from '../ports/IUserSettingsRepository';
import { ProgramNotFoundError } from '../ports/errors';
import { buildHistoryEntries, MacrocycleGenerationService } from './macrocycle-generation.service';

const PROGRAM = '5-3-1';

const stubDashboard = () => ({
  program: PROGRAM,
  macrocycleUnit: 'week' as const,
  macrocycleNum: 1,
  macrocycleDate: new Date('2026-04-20T00:00:00.000Z'),
  sheetName: '',
  macrocycleStartWeekday: Weekday.Monday,
});

const stubProgramSpec = () => [
  {
    week: 1,
    lift: 'Squat',
    order: 1,
    offset: 0,
    increment: 5,
    sets: 3,
    reps: 5,
    amrap: true,
    warmUpPct: '0.4,0.5,0.6',
    wtDecrementPct: 0.1,
    activation: 'compound',
  },
];

const stubTrainingMaxes = () => [
  {
    lift: 'Squat',
    weight: 250,
    dateUpdated: new Date('2026-04-18T00:00:00.000Z'),
  },
];

const stubLiftRecords = () => [
  {
    program: PROGRAM,
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date('2026-04-20T00:00:00.000Z'),
    lift: 'Squat',
    setNum: 1,
    weight: 265,
    reps: 5,
    notes: '',
  },
];

describe('MacrocycleGenerationService', () => {
  let service: MacrocycleGenerationService;
  let macrocycleDashboardRepo: jest.Mocked<IMacrocycleDashboardRepository>;
  let programSpecRepo: jest.Mocked<ILiftingProgramSpecRepository>;
  let trainingMaxRepo: jest.Mocked<ITrainingMaxRepository>;
  let trainingMaxHistoryRepo: jest.Mocked<ITrainingMaxHistoryRepository>;
  let liftRecordRepo: jest.Mocked<ILiftRecordRepository>;
  let userSettingsRepo: jest.Mocked<IUserSettingsRepository>;
  let macrocycleScheduledWorkoutRepo: jest.Mocked<IMacrocycleScheduledWorkoutRepository>;
  let repos: {
    macrocycleDashboard: jest.Mocked<IMacrocycleDashboardRepository>;
    macrocycleScheduledWorkout: jest.Mocked<IMacrocycleScheduledWorkoutRepository>;
    liftingProgramSpec: jest.Mocked<ILiftingProgramSpecRepository>;
    trainingMax: jest.Mocked<ITrainingMaxRepository>;
    trainingMaxHistory: jest.Mocked<ITrainingMaxHistoryRepository>;
    liftRecord: jest.Mocked<ILiftRecordRepository>;
    userSettings: jest.Mocked<IUserSettingsRepository>;
  };

  beforeEach(() => {
    macrocycleDashboardRepo = {
      getMacrocycleDashboard: jest.fn(),
      saveMacrocycleDashboard: jest.fn().mockResolvedValue(undefined),
      deleteMacrocycleDashboard: jest.fn().mockResolvedValue(undefined),
    };
    programSpecRepo = {
      getProgramSpec: jest.fn().mockResolvedValue(stubProgramSpec()),
      saveProgramSpec: jest.fn(),
      deleteSpecRows: jest.fn(),
    };
    trainingMaxRepo = {
      getTrainingMaxes: jest.fn(),
      saveTrainingMaxes: jest.fn().mockResolvedValue(undefined),
      importTrainingMaxes: jest.fn(),
      deleteTrainingMaxes: jest.fn().mockResolvedValue(undefined),
      deleteAllTrainingMaxes: jest.fn().mockResolvedValue(undefined),
    };
    trainingMaxHistoryRepo = {
      getHistory: jest.fn().mockResolvedValue([]),
      appendHistoryEntries: jest.fn().mockResolvedValue(undefined),
      updateHistoryEntry: jest.fn(),
      deleteAllHistory: jest.fn().mockResolvedValue(undefined),
    };
    liftRecordRepo = {
      getLiftRecords: jest.fn(),
      appendLiftRecords: jest.fn().mockResolvedValue(undefined),
      findExistingRecords: jest.fn(),
      updateLiftRecord: jest.fn(),
      deleteLiftRecordsByNaturalKeys: jest.fn(),
      deleteAllLiftRecords: jest.fn().mockResolvedValue(undefined),
    };
    userSettingsRepo = {
      getSettings: jest
        .fn()
        .mockResolvedValue({ activeProgram: null, workoutSchedule: null, defaultWeightIncrement: null }),
      upsertSettings: jest.fn(),
    };
    macrocycleScheduledWorkoutRepo = {
      getScheduledWorkouts: jest.fn().mockResolvedValue([]),
      saveScheduledWorkouts: jest.fn().mockResolvedValue(undefined),
    };
    repos = {
      macrocycleDashboard: macrocycleDashboardRepo,
      macrocycleScheduledWorkout: macrocycleScheduledWorkoutRepo,
      liftingProgramSpec: programSpecRepo,
      trainingMax: trainingMaxRepo,
      trainingMaxHistory: trainingMaxHistoryRepo,
      liftRecord: liftRecordRepo,
      userSettings: userSettingsRepo,
    };
    service = new MacrocycleGenerationService();
  });

  describe('startNewMacrocycle', () => {
    it('fetches current state, runs updateMacrocycle + updateMaxes, and persists both', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(stubLiftRecords());

      const { dashboard: result } = await service.startNewMacrocycle(repos, PROGRAM);

      expect(result.macrocycleNum).toBe(2);
      expect(result.program).toBe(PROGRAM);

      expect(macrocycleDashboardRepo.saveMacrocycleDashboard).toHaveBeenCalledWith(
        expect.objectContaining({ macrocycleNum: 2 }),
      );

      expect(trainingMaxRepo.saveTrainingMaxes).toHaveBeenCalledWith(
        PROGRAM,
        expect.arrayContaining([
          expect.objectContaining({ lift: 'Squat', weight: 270 }),
        ]),
      );
    });

    it('fetches lift records for the current macrocycle number', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue([]);

      await service.startNewMacrocycle(repos, PROGRAM);

      expect(liftRecordRepo.getLiftRecords).toHaveBeenCalledWith(PROGRAM, 1);
    });

    it('propagates ProgramNotFoundError from getMacrocycleDashboard', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(
        new Error('Program not found'),
      );

      await expect(service.startNewMacrocycle(repos, 'unknown')).rejects.toThrow(
        'Program not found',
      );
    });

    it('fetches records for fromMacrocycleNum when provided and advances from that macrocycle', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(stubLiftRecords());

      const { dashboard: result } = await service.startNewMacrocycle(repos, PROGRAM, { fromMacrocycleNum: 3 });

      expect(liftRecordRepo.getLiftRecords).toHaveBeenCalledWith(PROGRAM, 3);
      expect(result.macrocycleNum).toBe(4);
    });

    it('throws BadRequestException when fromMacrocycleNum has no records', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue([]);

      await expect(
        service.startNewMacrocycle(repos, PROGRAM, { fromMacrocycleNum: 5 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('pins macrocycleDate when macrocycleDate override is provided', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(stubLiftRecords());

      const { dashboard: result } = await service.startNewMacrocycle(repos, PROGRAM, { macrocycleDate: '2026-06-01' });

      expect(result.macrocycleDate).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    });

    it('saves scheduled dates when user has a workout schedule', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(stubLiftRecords());
      userSettingsRepo.getSettings.mockResolvedValue({
        activeProgram: null,
        workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
        defaultWeightIncrement: null,
      });

      await service.startNewMacrocycle(repos, PROGRAM);

      expect(macrocycleScheduledWorkoutRepo.saveScheduledWorkouts).toHaveBeenCalledWith(
        PROGRAM,
        2,
        expect.arrayContaining([
          expect.objectContaining({ workoutNum: 1, weekNum: 1 }),
        ]),
      );
    });

    it('clears the new macrocycle’s scheduled rows when user has no workout schedule (issue #1023)', async () => {
      // The macrocycle number may have been used before (fromMacrocycleNum, or delete then
      // re-initialize), and deleteCurrentMacrocycle clears only the current macrocycle's rows:
      // without a schedule the new macrocycle must not inherit an old one's dates.
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(stubLiftRecords());

      await service.startNewMacrocycle(repos, PROGRAM);

      expect(macrocycleScheduledWorkoutRepo.saveScheduledWorkouts).toHaveBeenCalledWith(PROGRAM, 2, []);
    });
  });

  describe('initializeFirstMacrocycle', () => {
    it('creates and saves a macrocycle-1 dashboard when none exists', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(
        new ProgramNotFoundError(PROGRAM),
      );

      const { dashboard: result } = await service.initializeFirstMacrocycle(
        repos,
        PROGRAM,
        { macrocycleDate: '2026-05-12' },
      );

      expect(result.macrocycleNum).toBe(1);
      expect(result.program).toBe(PROGRAM);
      expect(result.macrocycleUnit).toBe('week');
      expect(result.programType).toBe('5-3-1');
      expect(result.sheetName).toBe('5-3-1_Cycle_1_20260512');
      expect(result.macrocycleDate).toEqual(new Date('2026-05-12T00:00:00.000Z'));
      expect(result.macrocycleStartWeekday).toBe(Weekday.Tuesday); // 2026-05-12 is a Tuesday
      expect(macrocycleDashboardRepo.saveMacrocycleDashboard).toHaveBeenCalledWith(result);
    });

    it('defaults macrocycleDate to today when not provided', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(
        new ProgramNotFoundError(PROGRAM),
      );

      const before = new Date();
      const { dashboard: result } = await service.initializeFirstMacrocycle(repos, PROGRAM);
      const after = new Date();

      expect(result.macrocycleDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(result.macrocycleDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    });

    it('throws ConflictException when a macrocycle already exists', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());

      await expect(
        service.initializeFirstMacrocycle(repos, PROGRAM),
      ).rejects.toThrow(ConflictException);

      expect(macrocycleDashboardRepo.saveMacrocycleDashboard).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an unrecognized program', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(
        new ProgramNotFoundError('unknown-program'),
      );

      await expect(
        service.initializeFirstMacrocycle(repos, 'unknown-program'),
      ).rejects.toThrow(BadRequestException);

      expect(macrocycleDashboardRepo.saveMacrocycleDashboard).not.toHaveBeenCalled();
    });

    it('saves scheduled dates when user has a workout schedule', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(
        new ProgramNotFoundError(PROGRAM),
      );
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      userSettingsRepo.getSettings.mockResolvedValue({
        activeProgram: null,
        workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
        defaultWeightIncrement: null,
      });

      await service.initializeFirstMacrocycle(repos, PROGRAM, { macrocycleDate: '2026-05-12' });

      expect(macrocycleScheduledWorkoutRepo.saveScheduledWorkouts).toHaveBeenCalledWith(
        PROGRAM,
        1,
        expect.arrayContaining([
          expect.objectContaining({ workoutNum: 1, weekNum: 1 }),
        ]),
      );
    });

    it('schedules the full canonical program length, not the stored block (issue #680)', async () => {
      // PROGRAM = '5-3-1' has a canonical length of 12 weeks. Even though the stub
      // spec is a single block week of one day, every one of the 12 program weeks
      // must be scheduled, one workout per program day, so the workout calendar
      // covers the advertised plan.
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(
        new ProgramNotFoundError(PROGRAM),
      );
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      userSettingsRepo.getSettings.mockResolvedValue({
        activeProgram: null,
        workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
        defaultWeightIncrement: null,
      });

      await service.initializeFirstMacrocycle(repos, PROGRAM, { macrocycleDate: '2026-05-12' });

      const calls = macrocycleScheduledWorkoutRepo.saveScheduledWorkouts.mock.calls;
      expect(calls).toHaveLength(1);
      const workouts: Array<{ weekNum: number }> = calls[0]?.[2] ?? [];
      expect(workouts).toHaveLength(12);
      const weeks = [...new Set(workouts.map((w) => w.weekNum))].sort((a, b) => a - b);
      expect(weeks).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    });

    describe('numbers scheduled workouts by program day, whatever the schedule (issue #1023)', () => {
      // A schedule only dates the program's days: scheduled workout N is the
      // program's N-th (week, offset) day — what the Macrocycle Dashboard card and the
      // workout endpoint show — on the schedule's N-th date. Before #1023 it was
      // numbered through the schedule's calendar weeks, so any schedule not
      // training the program's own number of days every week drifted.
      const { MON, TUE, WED, THU, FRI } = DAY_INDEX;
      // distributeWorkouts builds local-time dates, so read the weekday back the
      // same way (0 = Monday).
      const weekday = (d: Date) => (d.getDay() + 6) % 7;

      it.each<[string, string, UserWorkoutSchedule, number, number, number[]]>([
        // 5-3-1 trains 2 days a week for 12 weeks; the rotation alternates 3 and 2.
        ['a rotating schedule', '5-3-1', { type: 'rotating', weeks: [[MON, WED, FRI], [TUE, THU]] }, 24, 2, [MON, WED, FRI, TUE, THU]],
        ['more days a week than the program', '5-3-1', { type: 'fixed', days: [MON, TUE, WED, THU] }, 24, 2, [MON, TUE, WED, THU]],
        // Leangains trains 3 days a week for 12 weeks.
        ['fewer days a week than the program', 'leangains', { type: 'fixed', days: [MON, THU] }, 36, 3, [MON, THU]],
      ])('%s', async (_label, program, workoutSchedule, programDays, daysPerProgramWeek, rotation) => {
        macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError(program));
        // A copy: the preset is a shared, unfrozen module constant.
        programSpecRepo.getProgramSpec.mockResolvedValue(structuredClone(PRESET_BASE_SPECS[program] ?? []));
        userSettingsRepo.getSettings.mockResolvedValue({
          activeProgram: null,
          workoutSchedule,
          defaultWeightIncrement: null,
        });

        await service.initializeFirstMacrocycle(repos, program, { macrocycleDate: '2026-05-18' });

        const calls = macrocycleScheduledWorkoutRepo.saveScheduledWorkouts.mock.calls;
        expect(calls).toHaveLength(1);
        const workouts = calls[0]?.[2] ?? [];
        // One scheduled workout per program day: none past the last day, none missing.
        expect(workouts.map((w) => w.workoutNum)).toEqual(
          Array.from({ length: programDays }, (_, i) => i + 1),
        );
        // Each carries its day's program week, not the calendar week it falls in.
        expect(workouts.map((w) => w.weekNum)).toEqual(
          Array.from({ length: programDays }, (_, i) => Math.floor(i / daysPerProgramWeek) + 1),
        );
        // The dates walk the schedule in order.
        const times = workouts.map((w) => w.scheduledDate.getTime());
        expect(times).toEqual([...times].sort((a, b) => a - b));
        expect(new Set(times).size).toBe(times.length);
        expect(workouts.map((w) => weekday(w.scheduledDate))).toEqual(
          Array.from({ length: programDays }, (_, i) => rotation[i % rotation.length]),
        );
      });

      it.each<[string, Date[]]>([
        ['too few dates', [new Date(2026, 4, 18)]],
        ['no dates at all', []],
      ])(
        'leaves the macrocycle unscheduled, with a structured error, if distributeWorkouts breaks its contract: %s',
        async (_label, dates) => {
          // Unreachable through a valid schedule: it has at least one day, and
          // distributeWorkouts then dates every workout. Numbering doesn't depend on
          // the schedule (ADR-037), so dropping the dates beats failing every
          // scheduled user's macrocycle creation. The rows are cleared, not left alone,
          // so a reused macrocycle number doesn't keep another macrocycle's dates.
          jest.mocked(distributeWorkouts).mockReturnValueOnce(dates.length ? [{ week: 1, workouts: dates }] : []);
          macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError(PROGRAM));
          programSpecRepo.getProgramSpec.mockResolvedValue(structuredClone(PRESET_BASE_SPECS[PROGRAM] ?? []));
          userSettingsRepo.getSettings.mockResolvedValue({
            activeProgram: null,
            workoutSchedule: { type: 'fixed', days: [MON, WED, FRI] },
            defaultWeightIncrement: null,
          });
          const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

          try {
            const { dashboard } = await service.initializeFirstMacrocycle(repos, PROGRAM, { macrocycleDate: '2026-05-18' });

            expect(dashboard.macrocycleNum).toBe(1);
            expect(macrocycleDashboardRepo.saveMacrocycleDashboard).toHaveBeenCalledWith(dashboard);
            expect(macrocycleScheduledWorkoutRepo.saveScheduledWorkouts).toHaveBeenCalledWith(PROGRAM, 1, []);
            expect(errorSpy).toHaveBeenCalledWith(
              expect.objectContaining({ program: PROGRAM, macrocycleNum: 1, programDays: 24, dated: dates.length }),
              expect.stringContaining('left unscheduled'),
            );
          } finally {
            errorSpy.mockRestore();
          }
        },
      );
    });

    it('clears macrocycle 1’s scheduled rows when user has no workout schedule (issue #1023)', async () => {
      // A macrocycle 1 deleted from macrocycle 2 or later left its rows behind:
      // deleteCurrentMacrocycle clears only the current macrocycle's. Re-initializing without
      // a schedule must not run the new macrocycle 1 on those old dates.
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(
        new ProgramNotFoundError(PROGRAM),
      );

      await service.initializeFirstMacrocycle(repos, PROGRAM, { macrocycleDate: '2026-05-12' });

      expect(macrocycleScheduledWorkoutRepo.saveScheduledWorkouts).toHaveBeenCalledWith(PROGRAM, 1, []);
    });

    it('saves no scheduled dates, without crashing, when programSpec is empty and workoutSchedule is set', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(
        new ProgramNotFoundError(PROGRAM),
      );
      programSpecRepo.getProgramSpec.mockResolvedValue([]);
      userSettingsRepo.getSettings.mockResolvedValue({
        activeProgram: null,
        workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
        defaultWeightIncrement: null,
      });

      await expect(
        service.initializeFirstMacrocycle(repos, PROGRAM, { macrocycleDate: '2026-05-12' }),
      ).resolves.not.toThrow();

      // A program with no days has nothing to date: the macrocycle's rows are cleared.
      expect(macrocycleScheduledWorkoutRepo.saveScheduledWorkouts).toHaveBeenCalledWith(PROGRAM, 1, []);
    });
  });

  describe('deleteCurrentMacrocycle', () => {
    it('deletes lift records, training maxes, history, scheduled workouts, and the dashboard', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());

      await service.deleteCurrentMacrocycle(repos, PROGRAM);

      expect(liftRecordRepo.deleteAllLiftRecords).toHaveBeenCalledWith(PROGRAM);
      expect(trainingMaxHistoryRepo.deleteAllHistory).toHaveBeenCalledWith(PROGRAM);
      expect(trainingMaxRepo.deleteAllTrainingMaxes).toHaveBeenCalledWith(PROGRAM);
      expect(macrocycleScheduledWorkoutRepo.saveScheduledWorkouts).toHaveBeenCalledWith(PROGRAM, 1, []);
      expect(macrocycleDashboardRepo.deleteMacrocycleDashboard).toHaveBeenCalledWith(PROGRAM);
    });

    it('deletes sequentially, in a fixed order, ending with the dashboard', async () => {
      // The five deletes share one request-scoped Prisma transaction client, which
      // serializes queries on a single connection — asserting a real, deterministic
      // order here (rather than Promise.all's unordered settling) is itself the
      // regression guard for that constraint.
      const order: string[] = [];
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      liftRecordRepo.deleteAllLiftRecords.mockImplementation(async () => {
        order.push('liftRecord');
      });
      trainingMaxHistoryRepo.deleteAllHistory.mockImplementation(async () => {
        order.push('trainingMaxHistory');
      });
      trainingMaxRepo.deleteAllTrainingMaxes.mockImplementation(async () => {
        order.push('trainingMax');
      });
      macrocycleScheduledWorkoutRepo.saveScheduledWorkouts.mockImplementation(async () => {
        order.push('macrocycleScheduledWorkout');
      });
      macrocycleDashboardRepo.deleteMacrocycleDashboard.mockImplementation(async () => {
        order.push('macrocycleDashboard');
      });

      await service.deleteCurrentMacrocycle(repos, PROGRAM);

      expect(order).toEqual([
        'liftRecord',
        'trainingMaxHistory',
        'trainingMax',
        'macrocycleScheduledWorkout',
        'macrocycleDashboard',
      ]);
    });

    it('propagates ProgramNotFoundError when no macrocycle exists (404 path)', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError(PROGRAM));

      await expect(service.deleteCurrentMacrocycle(repos, PROGRAM)).rejects.toThrow(ProgramNotFoundError);
      expect(macrocycleDashboardRepo.deleteMacrocycleDashboard).not.toHaveBeenCalled();
      expect(liftRecordRepo.deleteAllLiftRecords).not.toHaveBeenCalled();
    });

    it('scopes the scheduled-workout clear to the dashboard current macrocycleNum', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue({ ...stubDashboard(), macrocycleNum: 3 });

      await service.deleteCurrentMacrocycle(repos, PROGRAM);

      expect(macrocycleScheduledWorkoutRepo.saveScheduledWorkouts).toHaveBeenCalledWith(PROGRAM, 3, []);
    });
  });

  describe('recalculateMaxes', () => {
    it('re-runs updateMaxes against current macrocycle records and persists', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(stubLiftRecords());

      const result = await service.recalculateMaxes(repos, PROGRAM);

      expect(result.maxes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ lift: 'Squat', weight: 270 }),
        ]),
      );
      expect(result.flagged).toEqual([]);
      expect(trainingMaxRepo.saveTrainingMaxes).toHaveBeenCalledWith(PROGRAM, result.maxes);
    });

    it('does not call saveMacrocycleDashboard', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue([]);

      await service.recalculateMaxes(repos, PROGRAM);

      expect(macrocycleDashboardRepo.saveMacrocycleDashboard).not.toHaveBeenCalled();
    });

    it('returns unchanged maxes when there are no lift records', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue([]);

      const result = await service.recalculateMaxes(repos, PROGRAM);

      expect(result.maxes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ lift: 'Squat', weight: 250 }),
        ]),
      );
    });
  });
});

describe('buildHistoryEntries', () => {
  const asOf = (weight: number) => ({
    lift: 'Squat',
    weight,
    dateUpdated: new Date('2026-04-18T00:00:00.000Z'),
  });
  const date = new Date('2026-04-20T00:00:00.000Z');

  it('records a real sub-0.1lb change that a 1-decimal-place comparison would have missed', () => {
    // 316.25 -> 316.30 is a genuine 0.05lb change; both round to 316.3 at 1
    // decimal place, which would have silently dropped this from history.
    const entries = buildHistoryEntries([asOf(316.25)], [asOf(316.3)], date, 'program');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ lift: 'Squat', weight: 316.3 });
  });

  it('does not record an unchanged weight', () => {
    const entries = buildHistoryEntries([asOf(316.25)], [asOf(316.25)], date, 'program');

    expect(entries).toHaveLength(0);
  });

  it('records a lift with no prior entry', () => {
    const entries = buildHistoryEntries([], [asOf(316.25)], date, 'test');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ lift: 'Squat', weight: 316.25, source: 'test' });
  });
});
