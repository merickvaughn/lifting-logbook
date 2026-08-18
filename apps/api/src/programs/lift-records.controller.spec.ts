import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Weekday } from '@lifting-logbook/core';
import { ICycleDashboardRepository } from '../ports/ICycleDashboardRepository';
import { ILiftRecordRepository } from '../ports/ILiftRecordRepository';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { LiftRecordsController } from './lift-records.controller';

const MOCK_USER = { id: 'test-user', email: 'test@example.com', provider: 'dev' };

const SEED_DASHBOARD = {
  program: '5-3-1',
  cycleUnit: 'week' as const,
  cycleNum: 4,
  cycleDate: new Date('2026-04-20T00:00:00.000Z'),
  sheetName: '',
  cycleStartWeekday: Weekday.Monday,
};

const SEED_RECORD = {
  program: '5-3-1',
  cycleNum: 4,
  workoutNum: 1,
  date: new Date('2026-04-20T00:00:00.000Z'),
  lift: 'Bench Press',
  setNum: 1,
  weight: 180,
  reps: 5,
  notes: '',
};

describe('LiftRecordsController', () => {
  let controller: LiftRecordsController;
  let liftRecordRepo: jest.Mocked<ILiftRecordRepository>;
  let dashboardRepo: jest.Mocked<ICycleDashboardRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;

  beforeEach(async () => {
    liftRecordRepo = {
      getLiftRecords: jest.fn(),
      appendLiftRecords: jest.fn(),
      updateLiftRecord: jest.fn(),
      findExistingRecords: jest.fn().mockResolvedValue([]),
      deleteLiftRecordsByNaturalKeys: jest.fn().mockResolvedValue(0),
      deleteAllLiftRecords: jest.fn().mockResolvedValue(undefined),
    };
    dashboardRepo = {
      getCycleDashboard: jest.fn(),
      saveCycleDashboard: jest.fn(),
      deleteCycleDashboard: jest.fn().mockResolvedValue(undefined),
    };
    factory = {
      forUser: jest.fn().mockResolvedValue({
        liftRecord: liftRecordRepo,
        cycleDashboard: dashboardRepo,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LiftRecordsController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(LiftRecordsController);
  });

  describe('GET lift-records', () => {
    it('fetches lift records scoped to current cycle', async () => {
      dashboardRepo.getCycleDashboard.mockResolvedValue(SEED_DASHBOARD);
      liftRecordRepo.getLiftRecords.mockResolvedValue([SEED_RECORD]);

      const result = await controller.getLiftRecords('5-3-1', MOCK_USER);

      expect(liftRecordRepo.getLiftRecords).toHaveBeenCalledWith('5-3-1', 4);
      expect(result).toHaveLength(1);
      expect(result[0]?.lift).toBe('Bench Press');
      expect(result[0]?.date).toBe('2026-04-20');
    });
  });

  describe('POST lift-records', () => {
    it('appends the record and returns the serialized response', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(1);

      const result = await controller.createLiftRecord('5-3-1', {
        program: '5-3-1',
        cycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Bench Press',
        setNum: 1,
        weight: 180,
        reps: 5,
      }, MOCK_USER);

      expect(liftRecordRepo.appendLiftRecords).toHaveBeenCalledWith(
        '5-3-1',
        expect.arrayContaining([
          expect.objectContaining({ lift: 'Bench Press', setNum: 1, notes: '' }),
        ]),
      );
      expect(result.id).toBe('5-3-1-4-1-20260420-Bench Press-1');
      expect(result.notes).toBe('');
    });

    it('forwards optional notes to the record', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(1);

      const result = await controller.createLiftRecord('5-3-1', {
        program: '5-3-1',
        cycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Squat',
        setNum: 2,
        weight: 225,
        reps: 5,
        notes: 'felt good',
      }, MOCK_USER);

      expect(result.notes).toBe('felt good');
    });

    // Regression for #893's review round 2: a defensive guard independent of
    // whatever CreateLiftRecordDto's decorators do or don't catch. Calling the
    // controller directly (as this suite does throughout) bypasses the DTO/pipe
    // layer entirely, so this is the one place that exercises the controller's own
    // last-resort check in isolation.
    it('throws BadRequestException when date produces an Invalid Date, independent of DTO validation', async () => {
      await expect(
        controller.createLiftRecord('5-3-1', {
          program: '5-3-1',
          cycleNum: 4,
          workoutNum: 1,
          date: 'garbage-value',
          lift: 'Bench Press',
          setNum: 1,
          weight: 180,
          reps: 5,
        }, MOCK_USER),
      ).rejects.toThrow(BadRequestException);
      expect(liftRecordRepo.appendLiftRecords).not.toHaveBeenCalled();
    });

    // Regression for issue #884: the single-record path shares appendLiftRecords'
    // skipDuplicates semantics with the import path, so a collision must not
    // silently no-op and report success unless it's an idempotent retry (the
    // payload matches what's already stored — see the next test).
    it('throws ConflictException when the write collides with different data', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(0);
      liftRecordRepo.getLiftRecords.mockResolvedValue([
        { ...SEED_RECORD, lift: 'Bench Press', setNum: 1, weight: 999, reps: 1 },
      ]);

      await expect(
        controller.createLiftRecord('5-3-1', {
          program: '5-3-1',
          cycleNum: 4,
          workoutNum: 1,
          date: '2026-04-20',
          lift: 'Bench Press',
          setNum: 1,
          weight: 180,
          reps: 5,
        }, MOCK_USER),
      ).rejects.toThrow(ConflictException);
    });

    // A retry whose response was lost (timeout, dropped connection) resubmits
    // identical data — that must succeed, not stay permanently stuck on a
    // conflict the client has no way to resolve.
    it('returns the existing record instead of a conflict when the collision is an idempotent retry', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(0);
      const stored = { ...SEED_RECORD, lift: 'Bench Press', setNum: 1, weight: 180, reps: 5, notes: '' };
      liftRecordRepo.getLiftRecords.mockResolvedValue([stored]);

      const result = await controller.createLiftRecord('5-3-1', {
        program: '5-3-1',
        cycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Bench Press',
        setNum: 1,
        weight: 180,
        reps: 5,
      }, MOCK_USER);

      expect(result.weight).toBe(180);
      expect(result.reps).toBe(5);
    });
  });

  describe('PATCH lift-records/:id', () => {
    it('returns the updated record when found', async () => {
      const updated = { ...SEED_RECORD, weight: 185, reps: 4 };
      liftRecordRepo.updateLiftRecord.mockResolvedValue(updated);

      const result = await controller.updateLiftRecord(
        '5-3-1',
        '5-3-1-4-1-20260420-Bench Press-1',
        { weight: 185, reps: 4 },
        MOCK_USER,
      );

      expect(liftRecordRepo.updateLiftRecord).toHaveBeenCalledWith(
        '5-3-1',
        '5-3-1-4-1-20260420-Bench Press-1',
        { weight: 185, reps: 4 },
      );
      expect(result.weight).toBe(185);
      expect(result.reps).toBe(4);
    });

    it('throws NotFoundException when record does not exist', async () => {
      liftRecordRepo.updateLiftRecord.mockResolvedValue(null);

      await expect(
        controller.updateLiftRecord('5-3-1', 'unknown-id', { weight: 200 }, MOCK_USER),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
