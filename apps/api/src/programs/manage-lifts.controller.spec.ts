import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LIFT_NAMES } from '@lifting-logbook/types';
import { IMacrocycleDashboardRepository } from '../ports/IMacrocycleDashboardRepository';
import { ILiftingProgramSpecRepository } from '../ports/ILiftingProgramSpecRepository';
import { IWorkoutLiftOverrideRepository } from '../ports/IWorkoutLiftOverrideRepository';
import { IRepositoryFactory } from '../ports/factory';
import { ProgramNotFoundError } from '../ports/errors';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { ManageLiftsController } from './manage-lifts.controller';

const MOCK_USER_A = { id: 'user-a', email: 'a@example.com', provider: 'dev' };

const STUB_SPEC = [{ lift: 'Squat' }] as unknown as Awaited<
  ReturnType<ILiftingProgramSpecRepository['getProgramSpec']>
>;

describe('ManageLiftsController', () => {
  let controller: ManageLiftsController;
  let liftOverrideRepoA: jest.Mocked<IWorkoutLiftOverrideRepository>;
  let liftOverrideRepoB: jest.Mocked<IWorkoutLiftOverrideRepository>;
  let specRepoA: jest.Mocked<ILiftingProgramSpecRepository>;
  let specRepoB: jest.Mocked<ILiftingProgramSpecRepository>;
  let dashboardRepoA: jest.Mocked<IMacrocycleDashboardRepository>;
  let dashboardRepoB: jest.Mocked<IMacrocycleDashboardRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;

  beforeEach(async () => {
    liftOverrideRepoA = {
      getOverrides: jest.fn().mockResolvedValue([]),
      upsertOverride: jest.fn().mockResolvedValue(undefined),
      deleteOverride: jest.fn().mockResolvedValue(undefined),
    };
    liftOverrideRepoB = {
      getOverrides: jest.fn().mockResolvedValue([]),
      upsertOverride: jest.fn().mockResolvedValue(undefined),
      deleteOverride: jest.fn().mockResolvedValue(undefined),
    };
    specRepoA = { getProgramSpec: jest.fn().mockResolvedValue(STUB_SPEC), saveProgramSpec: jest.fn(), deleteSpecRows: jest.fn() } as jest.Mocked<ILiftingProgramSpecRepository>;
    specRepoB = { getProgramSpec: jest.fn().mockResolvedValue(STUB_SPEC), saveProgramSpec: jest.fn(), deleteSpecRows: jest.fn() } as jest.Mocked<ILiftingProgramSpecRepository>;
    dashboardRepoA = { getMacrocycleDashboard: jest.fn().mockResolvedValue({}), saveMacrocycleDashboard: jest.fn() } as unknown as jest.Mocked<IMacrocycleDashboardRepository>;
    dashboardRepoB = { getMacrocycleDashboard: jest.fn().mockResolvedValue({}), saveMacrocycleDashboard: jest.fn() } as unknown as jest.Mocked<IMacrocycleDashboardRepository>;
    const customLiftRepo = { list: jest.fn().mockResolvedValue([]) };
    factory = {
      forUser: jest.fn().mockImplementation(async (user) =>
        user.id === MOCK_USER_A.id
          ? { macrocycleDashboard: dashboardRepoA, workoutLiftOverride: liftOverrideRepoA, liftingProgramSpec: specRepoA, customLift: customLiftRepo }
          : { macrocycleDashboard: dashboardRepoB, workoutLiftOverride: liftOverrideRepoB, liftingProgramSpec: specRepoB, customLift: customLiftRepo },
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ManageLiftsController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(ManageLiftsController);
  });

  describe('getLifts', () => {
    it('returns the full LIFT_NAMES catalog when the user has no custom lifts', async () => {
      const result = await controller.getLifts(MOCK_USER_A);
      expect(result).toEqual([...LIFT_NAMES]);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('upsertOverride', () => {
    it('stores an add override and returns it', async () => {
      const result = await controller.upsertOverride(
        '5-3-1', '3', '1',
        { action: 'add', lift: 'Chin-up' },
        MOCK_USER_A,
      );

      expect(liftOverrideRepoA.upsertOverride).toHaveBeenCalledWith(
        '5-3-1', 3, 1,
        { lift: 'Chin-up', action: 'add' },
      );
      expect(result).toEqual({ action: 'add', lift: 'Chin-up' });
    });

    it('stores a replace override with replacedBy', async () => {
      const result = await controller.upsertOverride(
        '5-3-1', '3', '1',
        { action: 'replace', lift: 'Squat', replacedBy: 'Front Squat' },
        MOCK_USER_A,
      );

      expect(result).toEqual({ action: 'replace', lift: 'Squat', replacedBy: 'Front Squat' });
    });

    it('throws 400 when action is replace but replacedBy is missing', async () => {
      await expect(
        controller.upsertOverride('5-3-1', '3', '1', { action: 'replace', lift: 'Squat' }, MOCK_USER_A),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws 404 when program is not found', async () => {
      specRepoA.getProgramSpec.mockResolvedValue([]);

      await expect(
        controller.upsertOverride('unknown', '3', '1', { action: 'add', lift: 'Squat' }, MOCK_USER_A),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propagates ProgramNotFoundError when macrocycle dashboard is missing', async () => {
      dashboardRepoA.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError('5-3-1'));

      await expect(
        controller.upsertOverride('5-3-1', '3', '1', { action: 'add', lift: 'Squat' }, MOCK_USER_A),
      ).rejects.toBeInstanceOf(ProgramNotFoundError);
      expect(liftOverrideRepoA.upsertOverride).not.toHaveBeenCalled();
    });

    it('throws 400 for invalid macrocycleNum', async () => {
      await expect(
        controller.upsertOverride('5-3-1', '0', '1', { action: 'add', lift: 'Squat' }, MOCK_USER_A),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('user isolation — user B repo is not touched by user A request', async () => {
      await controller.upsertOverride('5-3-1', '3', '1', { action: 'add', lift: 'Squat' }, MOCK_USER_A);

      expect(liftOverrideRepoA.upsertOverride).toHaveBeenCalledTimes(1);
      expect(liftOverrideRepoB.upsertOverride).not.toHaveBeenCalled();
    });
  });

  describe('deleteOverride', () => {
    it('calls deleteOverride on the repo', async () => {
      await controller.deleteOverride('5-3-1', '3', '1', 'Squat', MOCK_USER_A);

      expect(liftOverrideRepoA.deleteOverride).toHaveBeenCalledWith('5-3-1', 3, 1, 'Squat');
    });

    it('is idempotent — no error when lift not found', async () => {
      liftOverrideRepoA.deleteOverride.mockResolvedValue(undefined);
      await expect(
        controller.deleteOverride('5-3-1', '3', '1', 'NonExistent', MOCK_USER_A),
      ).resolves.toBeUndefined();
    });

    it('decodes URL-encoded lift name', async () => {
      await controller.deleteOverride('5-3-1', '3', '1', 'Bench%20Press', MOCK_USER_A);

      expect(liftOverrideRepoA.deleteOverride).toHaveBeenCalledWith('5-3-1', 3, 1, 'Bench Press');
    });

    it('user isolation — user B repo is not touched by user A request', async () => {
      await controller.deleteOverride('5-3-1', '3', '1', 'Squat', MOCK_USER_A);

      expect(liftOverrideRepoB.deleteOverride).not.toHaveBeenCalled();
    });
  });
});
