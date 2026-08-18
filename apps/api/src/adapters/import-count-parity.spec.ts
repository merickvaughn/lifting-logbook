import { PrismaClient } from '@prisma/client';
import {
  LiftingProgramSpec,
  StrengthGoalEntry,
  TrainingMax,
} from '@lifting-logbook/core';
import { InMemoryTrainingMaxRepository } from './in-memory/training-max.adapter';
import { InMemoryStrengthGoalRepository } from './in-memory/strength-goal.adapter';
import { InMemoryLiftingProgramSpecRepository } from './in-memory/lifting-program-spec.adapter';
import { PrismaTrainingMaxRepository } from './prisma/training-max.repository';
import { PrismaStrengthGoalRepository } from './prisma/strength-goal.repository';
import { HybridLiftingProgramSpecRepository } from './prisma/hybrid-program-spec.repository';

/**
 * Cross-adapter parity (#532): the in-memory and Prisma import-commit methods must
 * return identical {created, updated, skipped} for the same input. Both now route
 * through the shared `classifyAndCount` loop + the shared `*RowKind` classifiers,
 * so a future change to dedupe/tally semantics in one place can't desync the other.
 *
 * The in-memory adapter is seeded by importing the "existing" rows first (all
 * creates); the Prisma adapter is given the same existing snapshot via a mock
 * `findMany` whose `$transaction` runs the callback against an in-tx stub.
 */

const USER = 'user-1';
const PROGRAM = '5-3-1';
const SPEC_PROGRAM = '11111111-1111-4111-8111-111111111111';
const at = new Date('2026-01-01T00:00:00.000Z');

describe('import-commit count parity (in-memory vs Prisma)', () => {
  it('training maxes: identical counts for create/update/skip/dedupe', async () => {
    const existing: TrainingMax[] = [
      { lift: 'Squat', weight: 300, dateUpdated: at },
      { lift: 'Deadlift', weight: 350, dateUpdated: at },
    ];
    const incoming: TrainingMax[] = [
      { lift: 'Squat', weight: 300, dateUpdated: at }, // identical → skip
      { lift: 'Deadlift', weight: 400, dateUpdated: at }, // differs → update
      { lift: 'Bench', weight: 200, dateUpdated: at }, // absent → create
      { lift: 'Squat', weight: 999, dateUpdated: at }, // duplicate lift → collapsed
    ];

    const mem = new InMemoryTrainingMaxRepository();
    await mem.importTrainingMaxes(PROGRAM, existing);
    const memResult = await mem.importTrainingMaxes(PROGRAM, incoming);

    const tx = {
      trainingMax: {
        findMany: jest.fn().mockResolvedValue(existing.map((m) => ({ lift: m.lift, weight: m.weight }))),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaClient;
    const prismaResult = await new PrismaTrainingMaxRepository(prisma, USER).importTrainingMaxes(
      PROGRAM,
      incoming,
    );

    // Issue #884: the in-batch duplicate is now counted as skipped (was
    // silently dropped, untallied) — skipped: 2 = the pre-existing "identical
    // to stored" skip + the newly-visible in-batch-duplicate skip.
    expect(memResult).toEqual({ created: 1, updated: 1, skipped: 2 });
    expect(prismaResult).toEqual(memResult);
  });

  it('strength goals: identical counts for create/update/skip/dedupe', async () => {
    const existing: StrengthGoalEntry[] = [
      { lift: 'Squat', goalType: 'absolute', unit: 'lbs', target: 400, updatedAt: at },
      { lift: 'Deadlift', goalType: 'absolute', unit: 'lbs', target: 500, updatedAt: at },
    ];
    const incoming: StrengthGoalEntry[] = [
      { lift: 'Squat', goalType: 'absolute', unit: 'lbs', target: 400, updatedAt: at }, // skip
      { lift: 'Deadlift', goalType: 'absolute', unit: 'lbs', target: 505, updatedAt: at }, // update
      { lift: 'Bench', goalType: 'relative', unit: 'lbs', ratio: 1.5, updatedAt: at }, // create
      { lift: 'Squat', goalType: 'absolute', unit: 'lbs', target: 999, updatedAt: at }, // collapsed
    ];

    const mem = new InMemoryStrengthGoalRepository();
    await mem.importGoals(PROGRAM, existing);
    const memResult = await mem.importGoals(PROGRAM, incoming);

    const tx = {
      strengthGoal: {
        findMany: jest.fn().mockResolvedValue(
          existing.map((g) => ({
            lift: g.lift,
            goalType: g.goalType,
            unit: g.unit,
            target: g.target ?? null,
            ratio: g.ratio ?? null,
            updatedAt: g.updatedAt,
          })),
        ),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaClient;
    const prismaResult = await new PrismaStrengthGoalRepository(prisma, USER).importGoals(
      PROGRAM,
      incoming,
    );

    // Issue #884: the in-batch duplicate is now counted as skipped (was
    // silently dropped, untallied) — skipped: 2 = the pre-existing "identical
    // to stored" skip + the newly-visible in-batch-duplicate skip.
    expect(memResult).toEqual({ created: 1, updated: 1, skipped: 2 });
    expect(prismaResult).toEqual(memResult);
  });

  it('program spec: identical counts for create/update/skip/dedupe', async () => {
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
    const toRow = (s: LiftingProgramSpec) => ({ ...s, weekType: null });

    const existing = [spec('Squat', 5), spec('Bench', 5)];
    const incoming = [
      spec('Squat', 5), // identical → skip
      spec('Bench', 3), // sets differ → update
      spec('Deadlift', 5), // absent → create
      spec('Squat', 9), // duplicate natural key → collapsed
    ];

    const mem = new InMemoryLiftingProgramSpecRepository();
    await mem.saveProgramSpec(SPEC_PROGRAM, existing);
    const memResult = await mem.saveProgramSpec(SPEC_PROGRAM, incoming);

    const tx = {
      customProgram: { findFirst: jest.fn().mockResolvedValue({ id: SPEC_PROGRAM }) },
      customProgramSpec: {
        findMany: jest.fn().mockResolvedValue(existing.map(toRow)),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaClient;
    const prismaResult = await new HybridLiftingProgramSpecRepository(prisma, USER).saveProgramSpec(
      SPEC_PROGRAM,
      incoming,
    );

    // Issue #884: the in-batch duplicate is now counted as skipped (was
    // silently dropped, untallied) — skipped: 2 = the pre-existing "identical
    // to stored" skip + the newly-visible in-batch-duplicate skip.
    expect(memResult).toEqual({ created: 1, updated: 1, skipped: 2 });
    expect(prismaResult).toEqual(memResult);
  });
});
