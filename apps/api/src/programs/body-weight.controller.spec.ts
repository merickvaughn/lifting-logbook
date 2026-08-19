import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IBodyWeightRepository } from '../ports/IBodyWeightRepository';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { BodyWeightController } from './body-weight.controller';

const MOCK_USER = { id: 'test-user', email: 'test@example.com', provider: 'dev' };

describe('BodyWeightController', () => {
  let controller: BodyWeightController;
  let repo: jest.Mocked<IBodyWeightRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;

  beforeEach(async () => {
    repo = { recordBodyWeight: jest.fn(), getLatestBodyWeight: jest.fn() };
    factory = {
      forUser: jest.fn().mockResolvedValue({ bodyWeight: repo }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BodyWeightController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(BodyWeightController);
  });

  describe('recordBodyWeight', () => {
    it('resolves the repository for the current user and records the entry', async () => {
      repo.recordBodyWeight.mockResolvedValue(undefined);

      await controller.recordBodyWeight(
        '5-3-1',
        { date: '2026-05-01', weight: 185, unit: 'lbs' },
        MOCK_USER,
      );

      expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
      expect(repo.recordBodyWeight).toHaveBeenCalledWith('5-3-1', {
        date: new Date('2026-05-01'),
        weight: 185,
        unit: 'lbs',
      });
    });
  });

  describe('getLatestBodyWeight', () => {
    it('returns the mapped response with an ISO date when an entry exists', async () => {
      repo.getLatestBodyWeight.mockResolvedValue({
        date: new Date('2026-05-01T00:00:00.000Z'),
        weight: 185,
        unit: 'lbs',
      });

      const result = await controller.getLatestBodyWeight('5-3-1', MOCK_USER);

      expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
      expect(repo.getLatestBodyWeight).toHaveBeenCalledWith('5-3-1');
      expect(result).toEqual({ date: '2026-05-01', weight: 185, unit: 'lbs' });
    });

    it('throws NotFoundException when nothing has been recorded for the program', async () => {
      repo.getLatestBodyWeight.mockResolvedValue(null);

      await expect(
        controller.getLatestBodyWeight('5-3-1', MOCK_USER),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
