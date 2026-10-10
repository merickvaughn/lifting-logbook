import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IMacrocycleDashboardRepository } from '../ports/IMacrocycleDashboardRepository';
import { ILiftingProgramSpecRepository } from '../ports/ILiftingProgramSpecRepository';
import { IWorkoutSkipOverrideRepository } from '../ports/IWorkoutSkipOverrideRepository';
import { IRepositoryFactory } from '../ports/factory';
import { ProgramNotFoundError } from '../ports/errors';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { WorkoutSkipController } from './workout-skip.controller';

const MOCK_USER = { id: 'u1', email: 'test@example.com', provider: 'dev' };

// A realistic 2-offset week-1 block. `5-3-1` is a registered 12-week program, so
// workoutKeyForWorkoutNum tiles this block across 12 weeks -> 24 workout days;
// workoutNum 1..24 resolve to a real day. The controller's new upper-bound check
// needs a spec that actually resolves the tested workoutNum, not a bare stub.
const baseSpecFields = {
  increment: 5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: true,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0.1,
  activation: 'compound',
};
const STUB_SPEC = [
  { ...baseSpecFields, offset: 0, lift: 'Squat', week: 1 },
  { ...baseSpecFields, offset: 3, lift: 'Bench Press', week: 1 },
] as unknown as Awaited<ReturnType<ILiftingProgramSpecRepository['getProgramSpec']>>;

describe('WorkoutSkipController', () => {
  let controller: WorkoutSkipController;
  let skipRepo: jest.Mocked<IWorkoutSkipOverrideRepository>;
  let specRepo: jest.Mocked<ILiftingProgramSpecRepository>;
  let dashboardRepo: jest.Mocked<IMacrocycleDashboardRepository>;

  beforeEach(async () => {
    skipRepo = {
      getSkipsForMacrocycle: jest.fn(),
      skipWorkout: jest.fn().mockResolvedValue(undefined),
      unskipWorkout: jest.fn().mockResolvedValue(undefined),
    };
    specRepo = {
      getProgramSpec: jest.fn().mockResolvedValue(STUB_SPEC),
      saveProgramSpec: jest.fn(),
      deleteSpecRows: jest.fn(),
    } as jest.Mocked<ILiftingProgramSpecRepository>;
    // Active macrocycle is 2 — the valid-input tests skip/unskip macrocycle 2; the
    // controller's new macrocycle-match check compares the path macrocycleNum against this
    // dashboard macrocycleNum.
    dashboardRepo = {
      getMacrocycleDashboard: jest.fn().mockResolvedValue({ macrocycleNum: 2 }),
      saveMacrocycleDashboard: jest.fn(),
    } as unknown as jest.Mocked<IMacrocycleDashboardRepository>;
    const factory: jest.Mocked<IRepositoryFactory> = {
      forUser: jest.fn().mockResolvedValue({
        workoutSkipOverride: skipRepo,
        liftingProgramSpec: specRepo,
        macrocycleDashboard: dashboardRepo,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkoutSkipController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(WorkoutSkipController);
  });

  describe('skipWorkout', () => {
    it('throws 400 for non-numeric macrocycleNum', async () => {
      await expect(
        controller.skipWorkout('5-3-1', 'abc', '1', {}, MOCK_USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 for macrocycleNum < 1', async () => {
      await expect(
        controller.skipWorkout('5-3-1', '0', '1', {}, MOCK_USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 for non-numeric workoutNum', async () => {
      await expect(
        controller.skipWorkout('5-3-1', '1', 'abc', {}, MOCK_USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 for workoutNum < 1', async () => {
      await expect(
        controller.skipWorkout('5-3-1', '1', '0', {}, MOCK_USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 404 for an unknown program', async () => {
      specRepo.getProgramSpec.mockResolvedValue([]);
      await expect(
        controller.skipWorkout('no-such-program', '2', '3', {}, MOCK_USER),
      ).rejects.toThrow(NotFoundException);
      expect(skipRepo.skipWorkout).not.toHaveBeenCalled();
    });

    it('throws 400 for a workoutNum beyond the program length', async () => {
      // 5-3-1 is 12 weeks x 2 offsets = 24 workout days; 9999 maps to no real day.
      await expect(
        controller.skipWorkout('5-3-1', '2', '9999', {}, MOCK_USER),
      ).rejects.toThrow(BadRequestException);
      expect(skipRepo.skipWorkout).not.toHaveBeenCalled();
    });

    it('throws 400 for a macrocycleNum that is not the active macrocycle', async () => {
      // Active macrocycle is 2 (dashboard mock); a skip on macrocycle 7 could never be read.
      await expect(
        controller.skipWorkout('5-3-1', '7', '3', {}, MOCK_USER),
      ).rejects.toThrow(BadRequestException);
      expect(skipRepo.skipWorkout).not.toHaveBeenCalled();
    });

    it('propagates ProgramNotFoundError when the macrocycle dashboard is missing', async () => {
      dashboardRepo.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError('5-3-1'));
      await expect(
        controller.skipWorkout('5-3-1', '2', '3', {}, MOCK_USER),
      ).rejects.toThrow(ProgramNotFoundError);
      expect(skipRepo.skipWorkout).not.toHaveBeenCalled();
    });

    it('calls skipWorkout with parsed params and optional reason', async () => {
      await controller.skipWorkout('5-3-1', '2', '3', { reason: 'sick' }, MOCK_USER);
      expect(skipRepo.skipWorkout).toHaveBeenCalledWith('5-3-1', 2, 3, 'sick');
    });

    it('calls skipWorkout without reason when dto has none', async () => {
      await controller.skipWorkout('5-3-1', '2', '3', {}, MOCK_USER);
      expect(skipRepo.skipWorkout).toHaveBeenCalledWith('5-3-1', 2, 3, undefined);
    });
  });

  describe('unskipWorkout', () => {
    it('throws 400 for non-numeric macrocycleNum', async () => {
      await expect(
        controller.unskipWorkout('5-3-1', 'abc', '1', MOCK_USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 for macrocycleNum < 1', async () => {
      await expect(
        controller.unskipWorkout('5-3-1', '0', '1', MOCK_USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 for non-numeric workoutNum', async () => {
      await expect(
        controller.unskipWorkout('5-3-1', '1', 'abc', MOCK_USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 for workoutNum < 1', async () => {
      await expect(
        controller.unskipWorkout('5-3-1', '1', '0', MOCK_USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 404 for an unknown program', async () => {
      specRepo.getProgramSpec.mockResolvedValue([]);
      await expect(
        controller.unskipWorkout('no-such-program', '2', '3', MOCK_USER),
      ).rejects.toThrow(NotFoundException);
      expect(skipRepo.unskipWorkout).not.toHaveBeenCalled();
    });

    it('throws 400 for a workoutNum beyond the program length', async () => {
      await expect(
        controller.unskipWorkout('5-3-1', '2', '9999', MOCK_USER),
      ).rejects.toThrow(BadRequestException);
      expect(skipRepo.unskipWorkout).not.toHaveBeenCalled();
    });

    it('throws 400 for a macrocycleNum that is not the active macrocycle', async () => {
      await expect(
        controller.unskipWorkout('5-3-1', '7', '3', MOCK_USER),
      ).rejects.toThrow(BadRequestException);
      expect(skipRepo.unskipWorkout).not.toHaveBeenCalled();
    });

    it('propagates ProgramNotFoundError when the macrocycle dashboard is missing', async () => {
      dashboardRepo.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError('5-3-1'));
      await expect(
        controller.unskipWorkout('5-3-1', '2', '3', MOCK_USER),
      ).rejects.toThrow(ProgramNotFoundError);
      expect(skipRepo.unskipWorkout).not.toHaveBeenCalled();
    });

    it('calls unskipWorkout with parsed params', async () => {
      await controller.unskipWorkout('5-3-1', '2', '3', MOCK_USER);
      expect(skipRepo.unskipWorkout).toHaveBeenCalledWith('5-3-1', 2, 3);
    });
  });
});
