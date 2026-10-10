import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IMacrocycleDashboardRepository } from '../ports/IMacrocycleDashboardRepository';
import { ILiftingProgramSpecRepository } from '../ports/ILiftingProgramSpecRepository';
import { IWorkoutDateOverrideRepository } from '../ports/IWorkoutDateOverrideRepository';
import { IRepositoryFactory } from '../ports/factory';
import { ProgramNotFoundError } from '../ports/errors';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { RescheduleController } from './reschedule.controller';

const MOCK_USER_A = { id: 'user-a', email: 'a@example.com', provider: 'dev' };
const _MOCK_USER_B = { id: 'user-b', email: 'b@example.com', provider: 'dev' };

// A realistic 2-offset week-1 block. `5-3-1` is a registered 12-week program, so
// workoutKeyForWorkoutNum tiles this block across 12 weeks → 24 workout days;
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

describe('RescheduleController', () => {
  let controller: RescheduleController;
  let overrideRepoA: jest.Mocked<IWorkoutDateOverrideRepository>;
  let overrideRepoB: jest.Mocked<IWorkoutDateOverrideRepository>;
  let specRepoA: jest.Mocked<ILiftingProgramSpecRepository>;
  let specRepoB: jest.Mocked<ILiftingProgramSpecRepository>;
  let dashboardRepoA: jest.Mocked<IMacrocycleDashboardRepository>;
  let dashboardRepoB: jest.Mocked<IMacrocycleDashboardRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;

  beforeEach(async () => {
    overrideRepoA = {
      getOverride: jest.fn().mockResolvedValue(null),
      upsertOverride: jest.fn().mockResolvedValue(undefined),
    };
    overrideRepoB = {
      getOverride: jest.fn().mockResolvedValue(null),
      upsertOverride: jest.fn().mockResolvedValue(undefined),
    };
    specRepoA = { getProgramSpec: jest.fn().mockResolvedValue(STUB_SPEC), saveProgramSpec: jest.fn(), deleteSpecRows: jest.fn() } as jest.Mocked<ILiftingProgramSpecRepository>;
    specRepoB = { getProgramSpec: jest.fn().mockResolvedValue(STUB_SPEC), saveProgramSpec: jest.fn(), deleteSpecRows: jest.fn() } as jest.Mocked<ILiftingProgramSpecRepository>;
    // Active macrocycle is 3 — the valid-input tests reschedule macrocycle 3; the controller's
    // new macrocycle-match check compares the path macrocycleNum against this dashboard macrocycleNum.
    dashboardRepoA = { getMacrocycleDashboard: jest.fn().mockResolvedValue({ macrocycleNum: 3 }), saveMacrocycleDashboard: jest.fn() } as unknown as jest.Mocked<IMacrocycleDashboardRepository>;
    dashboardRepoB = { getMacrocycleDashboard: jest.fn().mockResolvedValue({ macrocycleNum: 3 }), saveMacrocycleDashboard: jest.fn() } as unknown as jest.Mocked<IMacrocycleDashboardRepository>;
    factory = {
      forUser: jest.fn().mockImplementation(async (user) =>
        user.id === MOCK_USER_A.id
          ? { macrocycleDashboard: dashboardRepoA, workoutDateOverride: overrideRepoA, liftingProgramSpec: specRepoA }
          : { macrocycleDashboard: dashboardRepoB, workoutDateOverride: overrideRepoB, liftingProgramSpec: specRepoB },
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RescheduleController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(RescheduleController);
  });

  it('upserts an override for valid inputs', async () => {
    await controller.reschedule('5-3-1', '3', '2', { newDate: '2026-05-15' }, MOCK_USER_A);

    expect(overrideRepoA.upsertOverride).toHaveBeenCalledWith(
      '5-3-1',
      3,
      2,
      new Date('2026-05-15T00:00:00Z'),
    );
  });

  it('returns no content (void) on success', async () => {
    const result = await controller.reschedule(
      '5-3-1',
      '3',
      '2',
      { newDate: '2026-05-15' },
      MOCK_USER_A,
    );
    expect(result).toBeUndefined();
  });

  it('rejects non-integer macrocycleNum', async () => {
    await expect(
      controller.reschedule('5-3-1', 'abc', '2', { newDate: '2026-05-15' }, MOCK_USER_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(overrideRepoA.upsertOverride).not.toHaveBeenCalled();
  });

  it('rejects zero macrocycleNum', async () => {
    await expect(
      controller.reschedule('5-3-1', '0', '2', { newDate: '2026-05-15' }, MOCK_USER_A),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-integer workoutNum', async () => {
    await expect(
      controller.reschedule('5-3-1', '3', 'xyz', { newDate: '2026-05-15' }, MOCK_USER_A),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects workoutNum less than 1', async () => {
    await expect(
      controller.reschedule('5-3-1', '3', '0', { newDate: '2026-05-15' }, MOCK_USER_A),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('user A reschedule does not affect user B repo', async () => {
    await controller.reschedule('5-3-1', '3', '2', { newDate: '2026-05-15' }, MOCK_USER_A);

    expect(overrideRepoA.upsertOverride).toHaveBeenCalledTimes(1);
    expect(overrideRepoB.upsertOverride).not.toHaveBeenCalled();
  });

  it('rejects unknown program with NotFoundException', async () => {
    specRepoA.getProgramSpec.mockResolvedValue([]);
    await expect(
      controller.reschedule('no-such-program', '3', '2', { newDate: '2026-05-15' }, MOCK_USER_A),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(overrideRepoA.upsertOverride).not.toHaveBeenCalled();
  });

  it('propagates ProgramNotFoundError when macrocycle dashboard is missing', async () => {
    dashboardRepoA.getMacrocycleDashboard.mockRejectedValue(new ProgramNotFoundError('5-3-1'));
    await expect(
      controller.reschedule('5-3-1', '3', '2', { newDate: '2026-05-15' }, MOCK_USER_A),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
    expect(overrideRepoA.upsertOverride).not.toHaveBeenCalled();
  });

  it('rejects a workoutNum beyond the program length with 400', async () => {
    // 5-3-1 is 12 weeks × 2 offsets = 24 workout days; 9999 maps to no real day, so
    // the override would be dead data. Reject rather than 204-with-no-effect.
    await expect(
      controller.reschedule('5-3-1', '3', '9999', { newDate: '2026-05-15' }, MOCK_USER_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(overrideRepoA.upsertOverride).not.toHaveBeenCalled();
  });

  it('rejects a macrocycleNum that is not the active macrocycle with 400', async () => {
    // Active macrocycle is 3 (dashboard mock); rescheduling macrocycle 7 would write an
    // override the current-macrocycle read model can never surface — reject it.
    await expect(
      controller.reschedule('5-3-1', '7', '2', { newDate: '2026-05-15' }, MOCK_USER_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(overrideRepoA.upsertOverride).not.toHaveBeenCalled();
  });
});
