import { Test, TestingModule } from '@nestjs/testing';
import { ITrainingMaxRepository } from '../ports/ITrainingMaxRepository';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { TrainingMaxesController } from './training-maxes.controller';

const MOCK_USER = { id: 'test-user', email: 'test@example.com', provider: 'dev' };

describe('TrainingMaxesController', () => {
  let controller: TrainingMaxesController;
  let repo: jest.Mocked<ITrainingMaxRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;

  beforeEach(async () => {
    repo = { getTrainingMaxes: jest.fn(), saveTrainingMaxes: jest.fn(), importTrainingMaxes: jest.fn(), deleteTrainingMaxes: jest.fn() };
    factory = {
      forUser: jest.fn().mockResolvedValue({ trainingMax: repo }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrainingMaxesController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(TrainingMaxesController);
  });

  it('returns mapped training maxes with unit and ISO date', async () => {
    repo.getTrainingMaxes.mockResolvedValue([
      {
        lift: 'Squat',
        weight: 315,
        dateUpdated: new Date('2026-04-20T00:00:00.000Z'),
      },
    ]);

    const result = await controller.getTrainingMaxes('5-3-1', MOCK_USER);

    expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
    expect(repo.getTrainingMaxes).toHaveBeenCalledWith('5-3-1');
    expect(result).toEqual([
      { lift: 'Squat', weight: 315, unit: 'lbs', dateUpdated: '2026-04-20' },
    ]);
  });

  describe('updateTrainingMaxes', () => {
    it('stamps only a changed weight, so saving the form can’t age an imported max (#1118)', async () => {
      const unchanged = new Date('2025-01-01');
      repo.getTrainingMaxes.mockResolvedValue([
        { lift: 'Squat', weight: 315, dateUpdated: unchanged },
        { lift: 'Bench Press', weight: 225, dateUpdated: unchanged },
      ]);
      repo.saveTrainingMaxes.mockResolvedValue(undefined);

      await controller.updateTrainingMaxes('5-3-1', {
        maxes: [
          { lift: 'Squat', weight: 325, unit: 'lbs' },
          { lift: 'Bench Press', weight: 225, unit: 'lbs' },
        ],
      }, MOCK_USER);

      const saved = repo.saveTrainingMaxes.mock.calls[0]?.[1] as { lift: string; dateUpdated: Date }[];
      expect(saved.find((m) => m.lift === 'Bench Press')?.dateUpdated).toBe(unchanged);
      expect(saved.find((m) => m.lift === 'Squat')?.dateUpdated).not.toBe(unchanged);
    });

    it('merges incoming maxes into existing set and returns updated list', async () => {
      repo.getTrainingMaxes.mockResolvedValue([
        { lift: 'Squat', weight: 315, dateUpdated: new Date('2026-04-20') },
        { lift: 'Bench Press', weight: 225, dateUpdated: new Date('2026-04-20') },
      ]);
      repo.saveTrainingMaxes.mockResolvedValue(undefined);

      const result = await controller.updateTrainingMaxes('5-3-1', {
        maxes: [{ lift: 'Squat', weight: 325, unit: 'lbs' }],
      }, MOCK_USER);

      expect(repo.saveTrainingMaxes).toHaveBeenCalledWith(
        '5-3-1',
        expect.arrayContaining([
          expect.objectContaining({ lift: 'Squat', weight: 325 }),
          expect.objectContaining({ lift: 'Bench Press', weight: 225 }),
        ]),
      );
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ lift: 'Squat', weight: 325, unit: 'lbs' }),
          expect.objectContaining({ lift: 'Bench Press', weight: 225, unit: 'lbs' }),
        ]),
      );
    });

    it('adds a new lift not previously recorded', async () => {
      repo.getTrainingMaxes.mockResolvedValue([]);
      repo.saveTrainingMaxes.mockResolvedValue(undefined);

      const result = await controller.updateTrainingMaxes('5-3-1', {
        maxes: [{ lift: 'Deadlift', weight: 405, unit: 'lbs' }],
      }, MOCK_USER);

      expect(repo.saveTrainingMaxes).toHaveBeenCalledWith(
        '5-3-1',
        [expect.objectContaining({ lift: 'Deadlift', weight: 405 })],
      );
      expect(result).toEqual([
        expect.objectContaining({ lift: 'Deadlift', weight: 405, unit: 'lbs' }),
      ]);
    });
  });

  describe('putModificationMax (#1153)', () => {
    const unchanged = new Date('2025-01-01');
    let modifications: { list: jest.Mock; getMaxes: jest.Mock; saveMaxes: jest.Mock };

    beforeEach(() => {
      modifications = {
        list: jest.fn().mockResolvedValue([{ id: 'wide', name: 'Wide grip', lift: 'cable-curl', maxMode: 'own' }]),
        getMaxes: jest.fn().mockResolvedValue([{ modificationId: 'wide', weight: 65, dateUpdated: unchanged }]),
        saveMaxes: jest.fn().mockResolvedValue(undefined),
      };
      factory.forUser = jest.fn().mockResolvedValue({ trainingMax: repo, liftModification: modifications });
    });

    it('keeps the date of an own max saved again at the same weight', async () => {
      const result = await controller.putModificationMax('5-3-1', 'wide', { weight: 65 }, MOCK_USER);

      expect(modifications.saveMaxes).not.toHaveBeenCalled();
      expect(result.dateUpdated).toBe('2025-01-01');
    });

    it('stamps a changed weight', async () => {
      await controller.putModificationMax('5-3-1', 'wide', { weight: 67.5 }, MOCK_USER);

      const saved = modifications.saveMaxes.mock.calls[0]?.[1] as { weight: number; dateUpdated: Date }[];
      expect(saved).toEqual([expect.objectContaining({ modificationId: 'wide', weight: 67.5 })]);
      expect(saved[0]?.dateUpdated).not.toBe(unchanged);
    });
  });
});
