import { PrismaClient } from '@prisma/client';
import { StrengthGoalEntry } from '@lifting-logbook/core';
import { PrismaStrengthGoalRepository } from './strength-goal.repository';

const USER = 'user-1';
const PROGRAM = '5-3-1';
const at = new Date('2026-01-01T00:00:00.000Z');

const abs = (lift: string, target: number): StrengthGoalEntry => ({
  lift,
  goalType: 'absolute',
  unit: 'lbs',
  target,
  updatedAt: at,
});
const rel = (lift: string, ratio: number): StrengthGoalEntry => ({
  lift,
  goalType: 'relative',
  unit: 'lbs',
  ratio,
  updatedAt: at,
});

/** Mock PrismaClient whose `$transaction` runs the callback against a stub tx client. */
function makePrisma(
  existing: Array<Record<string, unknown>>,
  upsert: jest.Mock = jest.fn().mockResolvedValue({}),
) {
  const findMany = jest.fn().mockResolvedValue(existing);
  const tx = { strengthGoal: { findMany, upsert } };
  const $transaction = jest.fn((cb: (t: typeof tx) => unknown) => cb(tx));
  const prisma = { $transaction } as unknown as PrismaClient;
  return { prisma, findMany, upsert, $transaction };
}

describe('PrismaStrengthGoalRepository.importGoals', () => {
  it('classifies create/update/skip from the write and dedupes within the batch', async () => {
    const { prisma, findMany, upsert, $transaction } = makePrisma([
      { lift: 'Squat', goalType: 'absolute', unit: 'lbs', target: 400, ratio: null, updatedAt: at },
      { lift: 'Deadlift', goalType: 'absolute', unit: 'lbs', target: 500, ratio: null, updatedAt: at },
    ]);
    const repo = new PrismaStrengthGoalRepository(prisma, USER);

    const result = await repo.importGoals(PROGRAM, [
      abs('Squat', 400), // identical → skip
      abs('Deadlift', 505), // target differs → update
      rel('Bench', 1.5), // absent → create
      abs('Squat', 999), // duplicate lift in batch → collapsed
    ]);

    // Issue #884: the in-batch duplicate (abs('Squat', 999)) is now counted as
    // skipped (was silently dropped, untallied) — skipped: 2 = the pre-existing
    // "identical to stored" skip + the newly-visible in-batch-duplicate skip.
    expect(result).toEqual({ created: 1, updated: 1, skipped: 2 });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, program: PROGRAM } }),
    );
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('runs the whole batch in one transaction and rolls back on a mid-batch failure', async () => {
    // The previous unwrapped per-row loop left earlier rows written when a later row
    // threw; importGoals now runs inside `$transaction`, so the rejection propagates
    // and Prisma rolls back the batch (issue #488).
    const upsert = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'));
    const { prisma, $transaction } = makePrisma([], upsert);
    const repo = new PrismaStrengthGoalRepository(prisma, USER);

    await expect(
      repo.importGoals(PROGRAM, [rel('Squat', 1.8), rel('Bench', 1.5)]),
    ).rejects.toThrow('boom');
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
