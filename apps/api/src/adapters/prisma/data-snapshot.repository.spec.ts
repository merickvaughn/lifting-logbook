import { PrismaClient } from '@prisma/client';
import { NewSnapshot, SNAPSHOT_KINDS } from '../../ports/IDataSnapshotRepository';
import { PrismaDataSnapshotRepository } from './data-snapshot.repository';

const USER = 'user-1';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-31T00:00:00.000Z');

const row = (kind: string) => ({
  id: 'snap-1',
  kind,
  scope: { programs: ['5-3-1'] },
  counts: {},
  createdAt: NOW,
  expiresAt: LATER,
});

const newSnapshot = {
  kind: 'clear',
  scope: { programs: ['5-3-1'] },
  counts: {},
  createdAt: NOW,
  expiresAt: LATER,
  data: {},
} as unknown as NewSnapshot;

function makeRepo(delegate: Record<string, jest.Mock>) {
  const prisma = { dataSnapshot: delegate } as unknown as PrismaClient;
  return new PrismaDataSnapshotRepository(prisma, USER);
}

describe('PrismaDataSnapshotRepository kinds (#1351)', () => {
  it('throws when `create` gets back a row of a kind this release does not read', async () => {
    // A kind no release writes yet; `overwrite` is read since #1182.
    const create = jest.fn().mockResolvedValue(row('merge'));
    await expect(makeRepo({ create }).create(newSnapshot)).rejects.toThrow('snapshot kind merge');
  });

  it('asks the database for known kinds only, in `list` and in `get`', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const findFirst = jest.fn().mockResolvedValue(null);
    const repo = makeRepo({ findMany, findFirst });

    await repo.list(NOW);
    await expect(repo.get('snap-1', NOW)).resolves.toBeNull();

    expect(findMany.mock.calls[0][0].where.kind).toEqual({ in: [...SNAPSHOT_KINDS] });
    expect(findFirst.mock.calls[0][0].where.kind).toEqual({ in: [...SNAPSHOT_KINDS] });
  });
});
