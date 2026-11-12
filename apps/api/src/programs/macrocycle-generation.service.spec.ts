import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PRESET_BASE_SPECS, Weekday, distributeWorkouts, programWorkoutKeys } from '@lifting-logbook/core';
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
  IWorkoutDateOverrideRepository,
} from '../ports';
import { IWorkoutLiftOverrideRepository } from '../ports/IWorkoutLiftOverrideRepository';
import { IMacrocycleScheduledWorkoutRepository } from '../ports/IMacrocycleScheduledWorkoutRepository';
import { IUserSettingsRepository } from '../ports/IUserSettingsRepository';
import { ProgramNotFoundError } from '../ports/errors';
import { InMemoryMacrocycleRepository, macrocycleRowFixture } from '../adapters/in-memory/macrocycle.adapter';
import { InMemoryImportBatchRepository } from '../adapters/in-memory/import-batch.adapter';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
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

const macrocycleRow = (macrocycleNum: number, overrides: Partial<MacrocycleRow> = {}): MacrocycleRow =>
  macrocycleRowFixture(macrocycleNum, { program: PROGRAM, ...overrides });

describe('MacrocycleGenerationService', () => {
  let service: MacrocycleGenerationService;
  let macrocycleDashboardRepo: jest.Mocked<IMacrocycleDashboardRepository>;
  let programSpecRepo: jest.Mocked<ILiftingProgramSpecRepository>;
  let trainingMaxRepo: jest.Mocked<ITrainingMaxRepository>;
  let trainingMaxHistoryRepo: jest.Mocked<ITrainingMaxHistoryRepository>;
  let liftRecordRepo: jest.Mocked<ILiftRecordRepository>;
  let userSettingsRepo: jest.Mocked<IUserSettingsRepository>;
  let macrocycleScheduledWorkoutRepo: jest.Mocked<IMacrocycleScheduledWorkoutRepository>;
  let workoutLiftOverrideRepo: jest.Mocked<IWorkoutLiftOverrideRepository>;
  let workoutDateOverrideRepo: jest.Mocked<IWorkoutDateOverrideRepository>;
  let macrocycleRepo: InMemoryMacrocycleRepository;
  let repos: {
    macrocycle: InMemoryMacrocycleRepository;
    macrocycleDashboard: jest.Mocked<IMacrocycleDashboardRepository>;
    macrocycleScheduledWorkout: jest.Mocked<IMacrocycleScheduledWorkoutRepository>;
    liftingProgramSpec: jest.Mocked<ILiftingProgramSpecRepository>;
    trainingMax: jest.Mocked<ITrainingMaxRepository>;
    trainingMaxHistory: jest.Mocked<ITrainingMaxHistoryRepository>;
    liftRecord: jest.Mocked<ILiftRecordRepository>;
    userSettings: jest.Mocked<IUserSettingsRepository>;
    workoutLiftOverride: jest.Mocked<IWorkoutLiftOverrideRepository>;
    workoutDateOverride: jest.Mocked<IWorkoutDateOverrideRepository>;
  };

  beforeEach(() => {
    macrocycleDashboardRepo = {
      getMacrocycleDashboard: jest.fn(),
      saveMacrocycleDashboard: jest.fn().mockResolvedValue(undefined),
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
      findStoredSets: jest.fn(),
      updateLiftRecord: jest.fn(),
      deleteLiftRecordsByNaturalKeys: jest.fn(),
      getLoggedWorkoutNums: jest.fn().mockResolvedValue(new Set<number>()),
      getRecordsForLifts: jest.fn(),
      getMacrocycleDateRanges: jest.fn().mockResolvedValue(new Map()),
    };
    // Macrocycle 1 is the stub dashboard's; tests that name others add them.
    macrocycleRepo = new InMemoryMacrocycleRepository([macrocycleRow(1)]);
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
    workoutLiftOverrideRepo = {
      getOverrides: jest.fn().mockResolvedValue([]),
      getOverridesForMacrocycle: jest.fn().mockResolvedValue(new Map()),
      upsertOverride: jest.fn(),
      deleteOverride: jest.fn(),
    };
    workoutDateOverrideRepo = {
      getOverride: jest.fn(),
      getOverridesForMacrocycle: jest.fn().mockResolvedValue(new Map()),
      upsertOverride: jest.fn(),
    };
    repos = {
      macrocycle: macrocycleRepo,
      macrocycleDashboard: macrocycleDashboardRepo,
      macrocycleScheduledWorkout: macrocycleScheduledWorkoutRepo,
      liftingProgramSpec: programSpecRepo,
      trainingMax: trainingMaxRepo,
      trainingMaxHistory: trainingMaxHistoryRepo,
      liftRecord: liftRecordRepo,
      userSettings: userSettingsRepo,
      workoutLiftOverride: workoutLiftOverrideRepo,
      workoutDateOverride: workoutDateOverrideRepo,
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
      macrocycleRepo.seed(macrocycleRow(3));

      const { dashboard: result } = await service.startNewMacrocycle(repos, PROGRAM, { fromMacrocycleNum: 3 });

      expect(liftRecordRepo.getLiftRecords).toHaveBeenCalledWith(PROGRAM, 3);
      // The next free number, which here is also the source + 1.
      expect(result.macrocycleNum).toBe(4);
    });

    // ADR-042: the source + 1 can be taken, so the new macrocycle takes the next free number.
    it('gives a fromMacrocycleNum start the next free number, not the source + 1', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue({ ...stubDashboard(), macrocycleNum: 3 });
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(stubLiftRecords());
      macrocycleRepo.seed(macrocycleRow(2));
      macrocycleRepo.seed(macrocycleRow(3));

      const { dashboard: result } = await service.startNewMacrocycle(repos, PROGRAM, { fromMacrocycleNum: 1 });

      expect(result.macrocycleNum).toBe(4);
      expect(await macrocycleRepo.findByNumber(PROGRAM, 4)).toMatchObject({ origin: 'live', status: 'in-progress' });
    });

    it('rejects a fromMacrocycleNum that is imported history, writing nothing', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      macrocycleRepo.seed(macrocycleRow(4, { origin: 'imported', status: 'completed' }));

      await expect(service.startNewMacrocycle(repos, PROGRAM, { fromMacrocycleNum: 4 })).rejects.toMatchObject({
        status: 409,
        response: { code: 'macrocycle-read-only' },
      });
      expect(trainingMaxRepo.saveTrainingMaxes).not.toHaveBeenCalled();
      expect(macrocycleDashboardRepo.saveMacrocycleDashboard).not.toHaveBeenCalled();
    });

    it('rejects an unknown fromMacrocycleNum with 404', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());

      await expect(service.startNewMacrocycle(repos, PROGRAM, { fromMacrocycleNum: 9 })).rejects.toMatchObject({
        status: 404,
        response: { code: 'macrocycle-not-found' },
      });
      expect(trainingMaxRepo.saveTrainingMaxes).not.toHaveBeenCalled();
    });

    // Decision 1: starting the next macrocycle closes the current one's row.
    it.each([
      ['completed', 'every workout', 0, new Date('2026-05-04T00:00:00.000Z')],
      ['abandoned', 'all but one workout', 1, new Date('2026-05-04T00:00:00.000Z')],
      ['abandoned', 'no workout', Infinity, null],
    ] as const)('closes the current row as %s with %s logged', async (status, _label, missing, last) => {
      const workouts = programWorkoutKeys(PROGRAM, stubProgramSpec()).map((_key, i) => i + 1);
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue([]);
      liftRecordRepo.getLoggedWorkoutNums.mockResolvedValue(new Set(workouts.slice(0, Math.max(0, workouts.length - missing))));
      liftRecordRepo.getMacrocycleDateRanges.mockResolvedValue(
        last ? new Map([[1, { first: new Date('2026-04-20T00:00:00.000Z'), last }]]) : new Map(),
      );

      await service.startNewMacrocycle(repos, PROGRAM);

      // With no sets, the row ends on its own start date.
      expect(await macrocycleRepo.findByNumber(PROGRAM, 1)).toMatchObject({
        status,
        endDate: last ?? macrocycleRow(1).startDate,
      });
    });

    it('keeps a status the lifter chose when it closes the current row', async () => {
      await macrocycleRepo.deleteAllExcept(PROGRAM, []);
      macrocycleRepo.seed(macrocycleRow(1, { status: 'overran', statusChosen: true }));
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue([]);

      await service.startNewMacrocycle(repos, PROGRAM);

      expect(await macrocycleRepo.findByNumber(PROGRAM, 1)).toMatchObject({ status: 'overran' });
    });

    it('throws BadRequestException when fromMacrocycleNum has no records', async () => {
      macrocycleRepo.seed(macrocycleRow(5));
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

    it("reads the closing macrocycle's dates before overwriting them, and dates its history by its schedule (issue #1028)", async () => {
      // fromMacrocycleNum 1 on a dashboard at macrocycle 2 starts macrocycle 3 (ADR-042; it
      // reused 2 before). The closing macrocycle's rows are still read before anything is saved.
      // By the calendar the closing macrocycle (starting in 2030) is in week 1, a training
      // week; its schedule already dated workout 2, week 2's test day, in 2026.
      const spec = [1, 2].map((week) => ({
        ...stubProgramSpec()[0]!,
        week,
        weekType: week === 2 ? ('test' as const) : ('training' as const),
      }));
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue({
        ...stubDashboard(),
        macrocycleNum: 2,
        macrocycleDate: new Date('2030-01-07T00:00:00.000Z'),
      });
      programSpecRepo.getProgramSpec.mockResolvedValue(spec);
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(stubLiftRecords());
      macrocycleScheduledWorkoutRepo.getScheduledWorkouts.mockResolvedValue([
        { workoutNum: 1, weekNum: 1, scheduledDate: new Date('2026-04-20T00:00:00.000Z') },
        { workoutNum: 2, weekNum: 1, scheduledDate: new Date('2026-04-22T00:00:00.000Z') },
      ]);

      macrocycleRepo.seed(macrocycleRow(2));

      const { dashboard } = await service.startNewMacrocycle(repos, PROGRAM, { fromMacrocycleNum: 1 });

      expect(dashboard.macrocycleNum).toBe(3);
      expect(workoutLiftOverrideRepo.getOverridesForMacrocycle).toHaveBeenCalledWith(PROGRAM, 1);
      expect(macrocycleScheduledWorkoutRepo.getScheduledWorkouts).toHaveBeenCalledWith(PROGRAM, 2);
      expect(workoutDateOverrideRepo.getOverridesForMacrocycle).toHaveBeenCalledWith(PROGRAM, 2);
      expect(macrocycleScheduledWorkoutRepo.getScheduledWorkouts.mock.invocationCallOrder[0]).toBeLessThan(
        macrocycleScheduledWorkoutRepo.saveScheduledWorkouts.mock.invocationCallOrder[0]!,
      );
      expect(trainingMaxHistoryRepo.appendHistoryEntries).toHaveBeenCalledWith(PROGRAM, [
        expect.objectContaining({ lift: 'Squat', weight: 270, source: 'test' }),
      ]);
    });

    // Imported history often names a lift the program doesn't plan (#1150).
    it('starts with a logged lift the program has no max or spec row for, and warns naming it', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue([
        ...stubLiftRecords(),
        ...stubLiftRecords().map((r) => ({ ...r, lift: 'Zercher Squat', weight: 185 })),
      ]);

      try {
        const { dashboard } = await service.startNewMacrocycle(repos, PROGRAM);

        expect(dashboard.macrocycleNum).toBe(2);
        expect(trainingMaxRepo.saveTrainingMaxes).toHaveBeenCalledWith(PROGRAM, [
          expect.objectContaining({ lift: 'Squat', weight: 270 }),
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          { program: PROGRAM, macrocycleNum: 1, lift: 'Zercher Squat', reason: 'no-training-max' },
          expect.stringContaining('#1150'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('names the source macrocycle in that warning when advancing from fromMacrocycleNum', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue(stubTrainingMaxes());
      liftRecordRepo.getLiftRecords.mockResolvedValue(
        stubLiftRecords().map((r) => ({ ...r, macrocycleNum: 3, lift: 'Zercher Squat' })),
      );
      macrocycleRepo.seed(macrocycleRow(3));

      try {
        await service.startNewMacrocycle(repos, PROGRAM, { fromMacrocycleNum: 3 });

        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ macrocycleNum: 3, lift: 'Zercher Squat' }),
          expect.any(String),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('initializeFirstMacrocycle', () => {
    // A program with no macrocycle yet.
    beforeEach(() => macrocycleRepo.deleteAllExcept(PROGRAM, []));

    // ADR-042: the first live macrocycle takes the number past any imported history.
    it('numbers the first live macrocycle past imported history, and gives it a live row', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError(PROGRAM));
      macrocycleRepo.seed(macrocycleRow(1, { origin: 'imported', status: 'completed' }));
      macrocycleRepo.seed(macrocycleRow(2, { origin: 'imported', status: 'abandoned' }));

      const { dashboard } = await service.initializeFirstMacrocycle(repos, PROGRAM, { macrocycleDate: '2026-11-02' });

      expect(dashboard.macrocycleNum).toBe(3);
      expect(dashboard.sheetName).toBe(`${PROGRAM}_Cycle_3_20261102`);
      expect(await macrocycleRepo.findByNumber(PROGRAM, 3)).toMatchObject({
        origin: 'live',
        status: 'in-progress',
        startDate: new Date('2026-11-02T00:00:00.000Z'),
      });
    });

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
      // distributeWorkouts returns UTC-midnight dates (#1031), so read the weekday
      // back in UTC (0 = Monday).
      const weekday = (d: Date) => (d.getUTCDay() + 6) % 7;

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
        // Every rotation here trains Monday, so the first workout is on the start
        // date itself, on any host (#1031).
        expect(workouts[0]?.scheduledDate.toISOString()).toBe('2026-05-18T00:00:00.000Z');
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
    // Every table that holds a number is cleared by one `deleteAllExcept`, which the factory and
    // db e2e suites cover table by table.
    let deleteRepos: typeof repos & { importBatch: InMemoryImportBatchRepository };

    beforeEach(() => {
      deleteRepos = { ...repos, importBatch: new InMemoryImportBatchRepository() };
    });

    it('deletes training maxes, their history, and every number from every table', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      const deleteAllExcept = jest.spyOn(macrocycleRepo, 'deleteAllExcept');

      await service.deleteCurrentMacrocycle(deleteRepos, PROGRAM);

      // No imported macrocycles, so nothing is kept.
      expect(deleteAllExcept).toHaveBeenCalledWith(PROGRAM, []);
      expect(trainingMaxHistoryRepo.deleteAllHistory).toHaveBeenCalledWith(PROGRAM);
      expect(trainingMaxRepo.deleteAllTrainingMaxes).toHaveBeenCalledWith(PROGRAM);
      expect(await macrocycleRepo.list(PROGRAM)).toEqual([]);
    });

    // Imported history survives a delete with its rows; live and legacy macrocycles go (ADR-042).
    it('keeps imported macrocycles and their rows, and removes live and legacy ones', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue({ ...stubDashboard(), macrocycleNum: 3 });
      macrocycleRepo.seed(macrocycleRow(2, { origin: 'imported', status: 'completed' }));
      macrocycleRepo.seed(macrocycleRow(3));
      macrocycleRepo.seed(macrocycleRow(4, { origin: 'legacy', status: 'unknown' }));
      const deleteAllExcept = jest.spyOn(macrocycleRepo, 'deleteAllExcept');

      await service.deleteCurrentMacrocycle(deleteRepos, PROGRAM);

      expect(deleteAllExcept).toHaveBeenCalledWith(PROGRAM, [2]);
      // Renumbering is off in unit tests, so the imported macrocycle keeps its number.
      expect((await macrocycleRepo.list(PROGRAM)).map((m) => m.macrocycleNum)).toEqual([2]);
    });

    it('drops lift-records batch keys on the numbers it deletes, keeping those on imported history', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue({ ...stubDashboard(), macrocycleNum: 3 });
      macrocycleRepo.seed(macrocycleRow(2, { origin: 'imported', status: 'completed' }));
      macrocycleRepo.seed(macrocycleRow(3));
      const created = { kind: 'created' as const, wrote: { weight: 1, reps: 1, notes: '' } };
      await deleteRepos.importBatch.save({
        id: 'b',
        userId: 'u',
        program: PROGRAM,
        destination: 'lift-records',
        preImage: { '2:1:Squat:1': created, '3:1:Squat:1': created, 'macrocycle-row:3': { kind: 'created', wrote: { macrocycleNum: 3 } } },
        createdAt: new Date(),
      });

      await service.deleteCurrentMacrocycle(deleteRepos, PROGRAM);

      expect(Object.keys((await deleteRepos.importBatch.findById('b', 'u'))?.preImage ?? {})).toEqual(['2:1:Squat:1']);
    });

    it('deletes sequentially, in a fixed order, ending with the numbered tables', async () => {
      // The deletes share one request-scoped Prisma transaction client, which
      // serializes queries on a single connection — asserting a real, deterministic
      // order here (rather than Promise.all's unordered settling) is itself the
      // regression guard for that constraint.
      const order: string[] = [];
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      trainingMaxHistoryRepo.deleteAllHistory.mockImplementation(async () => {
        order.push('trainingMaxHistory');
      });
      trainingMaxRepo.deleteAllTrainingMaxes.mockImplementation(async () => {
        order.push('trainingMax');
      });
      jest.spyOn(macrocycleRepo, 'deleteAllExcept').mockImplementation(async () => {
        order.push('numbered tables');
      });

      await service.deleteCurrentMacrocycle(deleteRepos, PROGRAM);

      expect(order).toEqual(['trainingMaxHistory', 'trainingMax', 'numbered tables']);
    });

    it('propagates ProgramNotFoundError when no macrocycle exists (404 path)', async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError(PROGRAM));
      const deleteAllExcept = jest.spyOn(macrocycleRepo, 'deleteAllExcept');

      await expect(service.deleteCurrentMacrocycle(deleteRepos, PROGRAM)).rejects.toThrow(ProgramNotFoundError);
      expect(deleteAllExcept).not.toHaveBeenCalled();
      expect(trainingMaxRepo.deleteAllTrainingMaxes).not.toHaveBeenCalled();
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
      expect(result.skipped).toEqual([]);
      expect(trainingMaxRepo.saveTrainingMaxes).toHaveBeenCalledWith(PROGRAM, result.maxes);
    });

    it("progresses a Manage Lifts replacement's own max by its slot's rules (#1028)", async () => {
      macrocycleDashboardRepo.getMacrocycleDashboard.mockResolvedValue(stubDashboard());
      programSpecRepo.getProgramSpec.mockResolvedValue(stubProgramSpec());
      trainingMaxRepo.getTrainingMaxes.mockResolvedValue([
        ...stubTrainingMaxes(),
        { lift: 'Box Squat', weight: 230, dateUpdated: new Date('2026-04-18T00:00:00.000Z') },
      ]);
      liftRecordRepo.getLiftRecords.mockResolvedValue(
        stubLiftRecords().map((r) => ({ ...r, lift: 'Box Squat', weight: 240 })),
      );
      workoutLiftOverrideRepo.getOverridesForMacrocycle.mockResolvedValue(
        new Map([[1, [{ lift: 'Squat', action: 'replace' as const, replacedBy: 'Box Squat' }]]]),
      );

      const result = await service.recalculateMaxes(repos, PROGRAM);

      expect(workoutLiftOverrideRepo.getOverridesForMacrocycle).toHaveBeenCalledWith(PROGRAM, 1);
      expect(result.maxes).toEqual([
        expect.objectContaining({ lift: 'Squat', weight: 250 }),
        expect.objectContaining({ lift: 'Box Squat', weight: 245 }),
      ]);
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
