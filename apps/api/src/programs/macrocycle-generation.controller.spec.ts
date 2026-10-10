import { Test, TestingModule } from '@nestjs/testing';
import { Weekday } from '@lifting-logbook/core';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { MacrocycleGenerationController } from './macrocycle-generation.controller';
import { MacrocycleGenerationService } from './macrocycle-generation.service';

const MOCK_USER = { id: 'test-user', email: 'test@example.com', provider: 'dev' };

const PROGRAM = '5-3-1';

const stubProgramSpec = () => [{
  week: 1,
  offset: 0,
  lift: 'Squat',
  increment: 5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: '40,50,60',
  wtDecrementPct: 0,
  activation: 'None',
  weekType: 'training' as const,
}];

const MOCK_BUNDLE = {} as RepositoryBundle;

const stubMacrocycleDashboard = () => ({
  program: PROGRAM,
  macrocycleUnit: 'week' as const,
  macrocycleNum: 2,
  macrocycleDate: new Date('2026-04-27T00:00:00.000Z'),
  sheetName: '5-3-1_Cycle_2_20260427',
  macrocycleStartWeekday: Weekday.Monday,
});

describe('MacrocycleGenerationController', () => {
  let controller: MacrocycleGenerationController;
  let service: jest.Mocked<Pick<MacrocycleGenerationService, 'startNewMacrocycle' | 'recalculateMaxes' | 'initializeFirstMacrocycle'>>;
  let factory: jest.Mocked<IRepositoryFactory>;

  beforeEach(async () => {
    service = {
      startNewMacrocycle: jest.fn(),
      recalculateMaxes: jest.fn(),
      initializeFirstMacrocycle: jest.fn(),
    };
    factory = {
      forUser: jest.fn().mockResolvedValue(MOCK_BUNDLE),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MacrocycleGenerationController],
      providers: [
        { provide: MacrocycleGenerationService, useValue: service },
        { provide: REPOSITORY_FACTORY, useValue: factory },
      ],
    }).compile();

    controller = module.get(MacrocycleGenerationController);
  });

  describe('startNewMacrocycle', () => {
    it('calls service with repos, program, and dto, returns mapped response', async () => {
      service.startNewMacrocycle.mockResolvedValue({ dashboard: stubMacrocycleDashboard(), programSpec: stubProgramSpec() });

      const result = await controller.startNewMacrocycle(PROGRAM, {}, MOCK_USER);

      expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
      expect(service.startNewMacrocycle).toHaveBeenCalledWith(MOCK_BUNDLE, PROGRAM, {});
      expect(result).toEqual({
        program: PROGRAM,
        macrocycleNum: 2,
        macrocycleStartDate: '2026-04-27',
        weeks: [],
        currentWeekType: 'training',
        dateOverrides: {},
        skippedWorkoutNums: [],
        completedWorkoutNums: [],
      });
    });

    it('passes fromMacrocycleNum and macrocycleDate through to service', async () => {
      service.startNewMacrocycle.mockResolvedValue({ dashboard: stubMacrocycleDashboard(), programSpec: stubProgramSpec() });

      await controller.startNewMacrocycle(PROGRAM, {
        fromMacrocycleNum: 1,
        macrocycleDate: '2026-05-01',
      }, MOCK_USER);

      expect(service.startNewMacrocycle).toHaveBeenCalledWith(MOCK_BUNDLE, PROGRAM, {
        fromMacrocycleNum: 1,
        macrocycleDate: '2026-05-01',
      });
    });

    it('propagates service errors (e.g. 404 from unknown program)', async () => {
      service.startNewMacrocycle.mockRejectedValue(new Error('Program not found'));

      await expect(controller.startNewMacrocycle('unknown', {}, MOCK_USER)).rejects.toThrow(
        'Program not found',
      );
    });
  });

  describe('initializeFirstMacrocycle', () => {
    const stubInitDashboard = () => ({
      program: PROGRAM,
      macrocycleUnit: 'week' as const,
      macrocycleNum: 1,
      macrocycleDate: new Date('2026-05-12T00:00:00.000Z'),
      sheetName: '5-3-1_Cycle_1_20260512',
      macrocycleStartWeekday: Weekday.Monday,
      programType: '5-3-1',
    });

    it('calls service with repos, program, and dto, returns mapped response', async () => {
      service.initializeFirstMacrocycle.mockResolvedValue({ dashboard: stubInitDashboard(), programSpec: stubProgramSpec() });

      const result = await controller.initializeFirstMacrocycle(PROGRAM, {}, MOCK_USER);

      expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
      expect(service.initializeFirstMacrocycle).toHaveBeenCalledWith(MOCK_BUNDLE, PROGRAM, {});
      expect(result).toEqual({
        program: PROGRAM,
        macrocycleNum: 1,
        macrocycleStartDate: '2026-05-12',
        weeks: [],
        currentWeekType: 'training',
        dateOverrides: {},
        skippedWorkoutNums: [],
        completedWorkoutNums: [],
      });
    });

    it('passes optional macrocycleDate through to service', async () => {
      service.initializeFirstMacrocycle.mockResolvedValue({ dashboard: stubInitDashboard(), programSpec: stubProgramSpec() });

      await controller.initializeFirstMacrocycle(PROGRAM, { macrocycleDate: '2026-05-12' }, MOCK_USER);

      expect(service.initializeFirstMacrocycle).toHaveBeenCalledWith(
        MOCK_BUNDLE,
        PROGRAM,
        { macrocycleDate: '2026-05-12' },
      );
    });

    it('propagates service errors (e.g. ConflictException)', async () => {
      service.initializeFirstMacrocycle.mockRejectedValue(new Error('Already exists'));

      await expect(
        controller.initializeFirstMacrocycle(PROGRAM, {}, MOCK_USER),
      ).rejects.toThrow('Already exists');
    });
  });

  describe('recalculateMaxes', () => {
    it('calls service with repos and program, returns mapped maxes and flagged', async () => {
      service.recalculateMaxes.mockResolvedValue({
        maxes: [
          {
            lift: 'Squat',
            weight: 270,
            dateUpdated: new Date('2026-04-27T00:00:00.000Z'),
          },
        ],
        flagged: [],
      });

      const result = await controller.recalculateMaxes(PROGRAM, MOCK_USER);

      expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
      expect(service.recalculateMaxes).toHaveBeenCalledWith(MOCK_BUNDLE, PROGRAM);
      expect(result).toEqual({
        maxes: [{ lift: 'Squat', weight: 270, unit: 'lbs', dateUpdated: '2026-04-27' }],
        flagged: [],
      });
    });
  });
});
