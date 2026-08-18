import { PrismaClient } from '@prisma/client';
import { LiftingProgramSpec, PRESET_BASE_SPECS } from '@lifting-logbook/core';
import { HybridLiftingProgramSpecRepository } from './hybrid-program-spec.repository';

const CUSTOM_PROGRAM_ID = '11111111-1111-4111-8111-111111111111';

function makePrisma(): PrismaClient {
  return {
    customProgramSpec: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
}

const spec = (lift: string, sets: number): LiftingProgramSpec => ({
  week: 1,
  offset: 0,
  lift,
  order: 1,
  increment: 5,
  sets,
  reps: 5,
  amrap: false,
  warmUpPct: '0.65',
  wtDecrementPct: 0,
  activation: 'main',
});

/**
 * Mock whose `$transaction` runs the callback against a stub tx client so the
 * owner check, the single snapshot `findMany`, and the per-row `upsert` all run on
 * it. `existing` seeds the snapshot read; `ownerExists` toggles the owner guard.
 */
function makeSavePrisma(
  existing: Array<Record<string, unknown>> = [],
  ownerExists = true,
  upsert: jest.Mock = jest.fn().mockResolvedValue({}),
) {
  const findFirst = jest.fn().mockResolvedValue(ownerExists ? { id: CUSTOM_PROGRAM_ID } : null);
  const findMany = jest.fn().mockResolvedValue(existing);
  const tx = {
    customProgram: { findFirst },
    customProgramSpec: { findMany, upsert },
  };
  const $transaction = jest.fn((cb: (t: typeof tx) => unknown) => cb(tx));
  const prisma = { $transaction } as unknown as PrismaClient;
  return { prisma, findFirst, findMany, upsert, $transaction };
}

describe('HybridLiftingProgramSpecRepository', () => {
  it('routes built-in (non-UUID) program names to the in-memory adapter', async () => {
    const prisma = makePrisma();
    const repo = new HybridLiftingProgramSpecRepository(prisma, 'user-1');

    const spec = await repo.getProgramSpec('5-3-1');

    // In-memory built-in program resolves without touching the DB.
    expect(spec.length).toBeGreaterThan(0);
    expect(prisma.customProgramSpec.findMany).not.toHaveBeenCalled();
  });

  it('resolves leangains spec from the in-memory adapter', async () => {
    const prisma = makePrisma();
    const repo = new HybridLiftingProgramSpecRepository(prisma, 'user-1');

    const leangainsSpec = await repo.getProgramSpec('leangains');

    expect(leangainsSpec.length).toBeGreaterThan(0);
    expect(prisma.customProgramSpec.findMany).not.toHaveBeenCalled();
  });

  // Regression guard for issue #739. The Hybrid repo delegates every built-in
  // (non-UUID) program to the shared in-memory adapter — the exact path
  // production traffic uses, in both the in-memory and Prisma factories. That
  // adapter must serve EVERY PRESET_BASE_SPECS entry, not a hardcoded subset:
  // `rpt` was added to PRESET_BASE_SPECS in #596 but never seeded, so
  // getProgramSpec('rpt') silently returned []. Iterating the registry means a
  // future preset cannot regress the same way without failing here.
  it.each(Object.entries(PRESET_BASE_SPECS))(
    'serves the full built-in %s spec from the in-memory adapter (issue #739)',
    async (program, expectedSpec) => {
      const prisma = makePrisma();
      const repo = new HybridLiftingProgramSpecRepository(prisma, 'user-1');

      const result = await repo.getProgramSpec(program);

      expect(result.length).toBeGreaterThan(0);
      expect(result).toHaveLength(expectedSpec.length);
      expect(prisma.customProgramSpec.findMany).not.toHaveBeenCalled();
    },
  );

  it('scopes custom-program lookups to the requesting user (isolation guard)', async () => {
    const prisma = makePrisma();
    const repo = new HybridLiftingProgramSpecRepository(prisma, 'user-1');

    await repo.getProgramSpec(CUSTOM_PROGRAM_ID);

    expect(prisma.customProgramSpec.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { programId: CUSTOM_PROGRAM_ID, program: { userId: 'user-1' } },
      }),
    );
  });

  it("returns [] when another user's id yields no owned rows", async () => {
    const prisma = makePrisma();
    // findMany already resolves to [] for a non-owner because of the userId guard.
    const repo = new HybridLiftingProgramSpecRepository(prisma, 'attacker');

    const spec = await repo.getProgramSpec(CUSTOM_PROGRAM_ID);

    expect(spec).toEqual([]);
    expect(prisma.customProgramSpec.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { programId: CUSTOM_PROGRAM_ID, program: { userId: 'attacker' } },
      }),
    );
  });
});

describe('HybridLiftingProgramSpecRepository.saveProgramSpec', () => {
  it('rejects a built-in (non-UUID) program before touching the DB', async () => {
    const { prisma, $transaction } = makeSavePrisma();
    const repo = new HybridLiftingProgramSpecRepository(prisma, 'user-1');

    await expect(repo.saveProgramSpec('5-3-1', [spec('Squat', 5)])).rejects.toThrow(
      'requires a custom program',
    );
    expect($transaction).not.toHaveBeenCalled();
  });

  it('throws NotFound when the custom program is not owned by the user', async () => {
    const { prisma, findMany } = makeSavePrisma([], /* ownerExists */ false);
    const repo = new HybridLiftingProgramSpecRepository(prisma, 'user-1');

    await expect(repo.saveProgramSpec(CUSTOM_PROGRAM_ID, [spec('Squat', 5)])).rejects.toThrow(
      `Custom program ${CUSTOM_PROGRAM_ID} not found`,
    );
    // The owner guard short-circuits before the snapshot read.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('classifies create/update/skip from one snapshot read and dedupes within the batch', async () => {
    const toRow = (s: LiftingProgramSpec) => ({ ...s, weekType: null });
    const { prisma, findFirst, findMany, upsert, $transaction } = makeSavePrisma([
      toRow(spec('Squat', 5)),
      toRow(spec('Bench', 5)),
    ]);
    const repo = new HybridLiftingProgramSpecRepository(prisma, 'user-1');

    const result = await repo.saveProgramSpec(CUSTOM_PROGRAM_ID, [
      spec('Squat', 5), // identical → skip
      spec('Bench', 3), // sets differ → update
      spec('Deadlift', 5), // absent → create
      spec('Squat', 9), // duplicate natural key → collapsed
    ]);

    // Issue #884: the in-batch duplicate (spec('Squat', 9)) is now counted as
    // skipped (was silently dropped, untallied) — skipped: 2 = the pre-existing
    // "identical to stored" skip + the newly-visible in-batch-duplicate skip.
    expect(result).toEqual({ created: 1, updated: 1, skipped: 2 });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1); // owner guard
    // One up-front snapshot read (not a per-row findFirst), scoped to the program.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { programId: CUSTOM_PROGRAM_ID } });
    // Only the non-skip, non-duplicate rows are written, via upsert on the natural key.
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
