import { PrismaClient } from '@prisma/client';
import { PrismaWorkoutLiftOverrideRepository } from './workout-lift-override.repository';

const USER = 'user-1';

function makePrisma(rows: Array<{ lift: string; action: string; replacedBy: string | null }>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { workoutLiftOverride: { findMany } } as unknown as PrismaClient;
  return { prisma, findMany };
}

describe('PrismaWorkoutLiftOverrideRepository.getOverrides', () => {
  it('reads the workout’s overrides in the order each was last written (issue #1014)', async () => {
    // applyLiftOverrides resolves a chain of swaps only when applied in sequence.
    // Without an ORDER BY, Postgres may return rows in index order — alphabetical
    // by `lift` — which would apply Front Squat → Box Squat before the swap that
    // put Front Squat in the workout, silently dropping it. `createdAt` is the
    // last write because upsertOverride re-creates a re-saved row (below).
    const { prisma, findMany } = makePrisma([]);

    await new PrismaWorkoutLiftOverrideRepository(prisma, USER).getOverrides('5-3-1', 2, 7);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER, program: '5-3-1', cycleNum: 2, workoutNum: 7 },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('maps each row, dropping a null replacedBy', async () => {
    const { prisma } = makePrisma([
      { lift: 'Squat', action: 'replace', replacedBy: 'Front Squat' },
      { lift: 'Front Squat', action: 'replace', replacedBy: 'Box Squat' },
      { lift: 'Chin-up', action: 'add', replacedBy: null },
    ]);

    const overrides = await new PrismaWorkoutLiftOverrideRepository(prisma, USER).getOverrides('5-3-1', 2, 7);

    expect(overrides).toEqual([
      { lift: 'Squat', action: 'replace', replacedBy: 'Front Squat' },
      { lift: 'Front Squat', action: 'replace', replacedBy: 'Box Squat' },
      { lift: 'Chin-up', action: 'add' },
    ]);
    expect(overrides[2]).not.toHaveProperty('replacedBy');
  });
});

describe('PrismaWorkoutLiftOverrideRepository.upsertOverride', () => {
  it('re-creates the lift’s row in one transaction, so a re-saved override sorts last (issue #1014)', async () => {
    // An in-place update would keep the row's original createdAt: redoing a swap
    // after undoing it would then sort before the undo and change nothing.
    const deleteMany = jest.fn().mockReturnValue('delete-op');
    const create = jest.fn().mockReturnValue('create-op');
    const $transaction = jest.fn().mockResolvedValue([]);
    const prisma = { workoutLiftOverride: { deleteMany, create }, $transaction } as unknown as PrismaClient;

    await new PrismaWorkoutLiftOverrideRepository(prisma, USER).upsertOverride('5-3-1', 2, 7, {
      lift: 'Squat',
      action: 'replace',
      replacedBy: 'Front Squat',
    });

    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, program: '5-3-1', cycleNum: 2, workoutNum: 7, lift: 'Squat' },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        program: '5-3-1',
        cycleNum: 2,
        workoutNum: 7,
        lift: 'Squat',
        action: 'replace',
        replacedBy: 'Front Squat',
      },
    });
    // Both writes go through one batch transaction, delete first.
    expect($transaction).toHaveBeenCalledWith(['delete-op', 'create-op']);
  });
});
