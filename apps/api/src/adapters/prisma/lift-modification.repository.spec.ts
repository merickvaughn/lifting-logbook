import { PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { LiftModificationConflictError, LiftModificationNotFoundError } from '../../ports/errors';
import { PrismaLiftModificationRepository } from './lift-modification.repository';

const known = (code: string) => new PrismaClientKnownRequestError(code, { code, clientVersion: 'test' });

const ROW = {
  id: 'm1',
  userId: 'u',
  lift: 'squat',
  name: 'Paused',
  description: '',
  maxMode: 'none',
  archivedAt: null,
  createdAt: new Date(),
};

function setup() {
  const liftModification = {
    findFirst: jest.fn().mockResolvedValue(ROW),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn(),
  };
  const liftRecord = { findFirst: jest.fn().mockResolvedValue(null) };
  const prisma = { liftModification, liftRecord } as unknown as PrismaClient;
  return { repo: new PrismaLiftModificationRepository(prisma, 'u'), liftModification, liftRecord };
}

// A row can go between the ownership read and the write when two requests race, such as a
// double-tapped delete. That must read as the documented 404, not an unhandled 500.
describe('PrismaLiftModificationRepository, when a row goes between the read and the write', () => {
  it('update answers not found on P2025, and conflict on P2002', async () => {
    const { repo, liftModification } = setup();
    liftModification.update.mockRejectedValueOnce(known('P2025'));
    await expect(repo.update('m1', { description: 'x' })).rejects.toThrow(LiftModificationNotFoundError);
    liftModification.update.mockRejectedValueOnce(known('P2002'));
    await expect(repo.update('m1', { name: 'Taken' })).rejects.toThrow(LiftModificationConflictError);
  });

  it('create answers not found when the archived row it would bring back is gone', async () => {
    const { repo, liftModification } = setup();
    liftModification.update.mockRejectedValueOnce(known('P2025'));
    await expect(repo.create({ lift: 'squat', name: 'Paused' })).rejects.toThrow(LiftModificationNotFoundError);
  });

  it('delete answers not found when the row to remove is gone', async () => {
    const { repo, liftModification } = setup();
    liftModification.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.delete('m1')).rejects.toThrow(LiftModificationNotFoundError);
  });

  it('delete answers not found when the row to archive is gone', async () => {
    const { repo, liftModification, liftRecord } = setup();
    liftRecord.findFirst.mockResolvedValueOnce({ id: 'r1' });
    liftModification.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.delete('m1')).rejects.toThrow(LiftModificationNotFoundError);
  });

  it('rethrows anything else', async () => {
    const { repo, liftModification } = setup();
    liftModification.update.mockRejectedValueOnce(known('P1001'));
    await expect(repo.update('m1', { description: 'x' })).rejects.toThrow('P1001');
  });
});
