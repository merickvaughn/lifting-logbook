import { PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { CustomLiftNotFoundError } from '../../ports/errors';
import { PrismaCustomLiftRepository } from './custom-lift.repository';

const known = (code: string) =>
  new PrismaClientKnownRequestError(`mocked ${code}`, { code, clientVersion: 'test' });

const ROW = {
  id: 'c1',
  userId: 'u',
  name: 'Zercher Squat',
  classification: 'compound',
  patterns: [],
  jointActions: [],
  complexity: 'simple',
  isBodyweightComponent: false,
  createdAt: new Date(),
};

function setup() {
  const customLift = {
    findFirst: jest.fn().mockResolvedValue(ROW),
    update: jest.fn().mockResolvedValue(ROW),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const prisma = { customLift } as unknown as PrismaClient;
  return { repo: new PrismaCustomLiftRepository(prisma, 'u'), customLift };
}

// A row can go before the write lands when two requests race, such as a double-tapped delete:
// after update()'s ownership read, or after delete()'s request began. Either must read as the
// documented 404, not an unhandled 500.
describe('PrismaCustomLiftRepository, when a row goes before the write lands', () => {
  it('update answers not found on P2025', async () => {
    const { repo, customLift } = setup();
    customLift.update.mockRejectedValueOnce(known('P2025'));
    await expect(repo.update('c1', { name: 'Front Squat' })).rejects.toThrow(CustomLiftNotFoundError);
  });

  it('delete answers not found when the row to remove is gone', async () => {
    const { repo, customLift } = setup();
    customLift.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.delete('c1')).rejects.toThrow(CustomLiftNotFoundError);
  });

  it('delete scopes the write to the owner', async () => {
    const { repo, customLift } = setup();
    await repo.delete('c1');
    expect(customLift.deleteMany).toHaveBeenCalledWith({ where: { id: 'c1', userId: 'u' } });
  });

  it('rethrows anything else', async () => {
    const { repo, customLift } = setup();
    const other = known('P1001');
    customLift.update.mockRejectedValueOnce(other);
    await expect(repo.update('c1', { name: 'Front Squat' })).rejects.toBe(other);
  });
});
