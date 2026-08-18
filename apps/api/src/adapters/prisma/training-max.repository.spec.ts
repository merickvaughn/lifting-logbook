import { PrismaClient } from '@prisma/client';
import { TrainingMax } from '@lifting-logbook/core';
import { PrismaTrainingMaxRepository } from './training-max.repository';

const USER = 'user-1';
const PROGRAM = '5-3-1';
const d = new Date('2026-01-01T00:00:00.000Z');

const tm = (lift: string, weight: number): TrainingMax => ({ lift, weight, dateUpdated: d });

/**
 * A mock PrismaClient whose `$transaction` runs the callback against a stub tx
 * client — so `runInteractive` opens "a transaction" and the repo's read + upserts
 * all run on the same stub. `findMany` returns `existing`; `upsert` is a spy.
 */
function makePrisma(
  existing: Array<{ lift: string; weight: number }>,
  upsert: jest.Mock = jest.fn().mockResolvedValue({}),
) {
  const findMany = jest.fn().mockResolvedValue(existing);
  const tx = { trainingMax: { findMany, upsert } };
  const $transaction = jest.fn((cb: (t: typeof tx) => unknown) => cb(tx));
  const prisma = { $transaction } as unknown as PrismaClient;
  return { prisma, findMany, upsert, $transaction };
}

describe('PrismaTrainingMaxRepository.importTrainingMaxes', () => {
  it('classifies create/update/skip from the write and counts an in-batch duplicate as skipped', async () => {
    const { prisma, findMany, upsert, $transaction } = makePrisma([
      { lift: 'Squat', weight: 300 },
      { lift: 'Deadlift', weight: 350 },
    ]);
    const repo = new PrismaTrainingMaxRepository(prisma, USER);

    const result = await repo.importTrainingMaxes(PROGRAM, [
      tm('Squat', 300), // identical → skip
      tm('Deadlift', 400), // weight differs → update
      tm('Bench', 200), // absent → create
      tm('Squat', 999), // duplicate lift in batch → counted as skip, not re-written (#884)
    ]);

    // Issue #884: the in-batch duplicate ('Squat', 999) is now counted as
    // skipped (was silently dropped, untallied) — skipped: 2 = the pre-existing
    // "identical to stored" skip + the newly-visible in-batch-duplicate skip.
    expect(result).toEqual({ created: 1, updated: 1, skipped: 2 });
    // The whole batch ran inside one transaction; the existing read happened in it.
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, program: PROGRAM } }),
    );
    // Only the non-skip, non-duplicate rows are written.
    expect(upsert).toHaveBeenCalledTimes(2);
    const writtenLifts = upsert.mock.calls.map(
      (c) => (c[0] as { where: { userId_program_lift: { lift: string } } }).where.userId_program_lift.lift,
    );
    expect(writtenLifts.sort()).toEqual(['Bench', 'Deadlift']);
  });

  it('propagates a mid-batch write failure so the surrounding transaction rolls back', async () => {
    const upsert = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'));
    const { prisma } = makePrisma([], upsert);
    const repo = new PrismaTrainingMaxRepository(prisma, USER);

    // Two creates; the second write rejects. The rejection surfaces (not swallowed),
    // and because it threw inside `$transaction`, Prisma rolls the batch back.
    await expect(
      repo.importTrainingMaxes(PROGRAM, [tm('Squat', 300), tm('Bench', 200)]),
    ).rejects.toThrow('boom');
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
