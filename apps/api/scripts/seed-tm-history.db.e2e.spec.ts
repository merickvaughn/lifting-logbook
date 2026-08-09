// Real-Postgres E2E suite for the Phase 2B seed script (issue #885).
// Postgres is provisioned by ../jest.global-setup.js (see that file's header
// comment for the three provisioning paths: CI passthrough, local
// Testcontainers, or LIFTING_SKIP_DB_E2E=1 opt-out).
//
// Unlike programs.db.e2e.spec.ts, this suite has no reason to touch
// LIFTING_TC_DATABASE_URL (the restricted `lifting_app` role) at all — the
// seed script always connects as the migrator/owner role specifically to
// bypass RLS (see docs/phase2b-tm-history-seeding-runbook.md on
// gas-lifting-logbook), so LIFTING_TC_OWNER_DATABASE_URL is the only
// connection under test here, exactly mirroring the script's real
// production connection.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  backupExistingHistory,
  ProgramOwnershipError,
  runSeed,
  SeedArgs,
  verifyProgramOwnership,
} from './seed-tm-history';

const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
// Skip only when globalSetup did not provision a DB (e.g. Docker unavailable
// and not running in CI) — matches programs.db.e2e.spec.ts's pattern.
const describeOrSkip = OWNER_DATABASE_URL ? describe : describe.skip;

const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_A = 'seed-tm-history-e2e-user-a';
const USER_B = 'seed-tm-history-e2e-user-b';

async function cleanTestUsers(prisma: PrismaClient): Promise<void> {
  await prisma.trainingMaxHistory.deleteMany({
    where: { userId: { in: [USER_A, USER_B] } },
  });
  await prisma.customProgram.deleteMany({
    where: { userId: { in: [USER_A, USER_B] } },
  });
}

function tmpBackupDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seed-tm-history-e2e-'));
}

function csvOf(rows: Record<string, string>[]): string {
  const headers = [
    'Program',
    'Lift',
    'Cycle Date',
    'TM',
    'Goal Met',
    'Is PR',
    'Will Seed',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => row[h] ?? '').join(','));
  return lines.join('\n');
}

function willSeedRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Program: 'RPT',
    Lift: 'Squat',
    'Cycle Date': '2026-03-01',
    TM: '305',
    'Goal Met': 'true',
    'Is PR': 'true',
    'Will Seed': 'true',
    ...overrides,
  };
}

describeOrSkip('seed-tm-history (e2e, real Postgres, owner/migrator connection)', () => {
  let prisma: PrismaClient;
  let backupDir: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });
  }, DB_E2E_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanTestUsers(prisma);
    backupDir = tmpBackupDir();
  });

  afterAll(async () => {
    await cleanTestUsers(prisma);
    await prisma.$disconnect();
  });

  describe('verifyProgramOwnership', () => {
    it('resolves without throwing when the program belongs to the given user', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Owned Program' },
      });
      await expect(
        verifyProgramOwnership(prisma, program.id, USER_A),
      ).resolves.toBeUndefined();
    });

    it('throws ProgramOwnershipError when the program belongs to a different user', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Alice Program' },
      });
      await expect(
        verifyProgramOwnership(prisma, program.id, USER_B),
      ).rejects.toBeInstanceOf(ProgramOwnershipError);
    });

    it('throws ProgramOwnershipError when the program does not exist', async () => {
      await expect(
        verifyProgramOwnership(prisma, '00000000-0000-0000-0000-000000000000', USER_A),
      ).rejects.toThrow(/does not exist/);
    });
  });

  describe('backupExistingHistory', () => {
    it('returns null and writes no file when the program has no existing history', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Empty History' },
      });
      const { PrismaTrainingMaxHistoryRepository } = await import(
        '../src/adapters/prisma/training-max-history.repository'
      );
      const repo = new PrismaTrainingMaxHistoryRepository(prisma, USER_A);
      const result = await backupExistingHistory(repo, program.id, backupDir);
      expect(result).toBeNull();
    });

    it('writes existing history to a JSON file and returns its path + count', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Has History' },
      });
      await prisma.trainingMaxHistory.create({
        data: {
          userId: USER_A,
          program: program.id,
          lift: 'back-squat',
          weight: 300,
          reps: 1,
          date: new Date('2026-01-01'),
          isPR: true,
          source: 'program',
          goalMet: true,
        },
      });
      const { PrismaTrainingMaxHistoryRepository } = await import(
        '../src/adapters/prisma/training-max-history.repository'
      );
      const repo = new PrismaTrainingMaxHistoryRepository(prisma, USER_A);
      const result = await backupExistingHistory(repo, program.id, backupDir);
      expect(result).not.toBeNull();
      expect(result?.count).toBe(1);
      const written = JSON.parse(fs.readFileSync(result!.path, 'utf8'));
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ lift: 'back-squat', weight: 300 });
    });
  });

  describe('runSeed', () => {
    function baseArgs(program: string, input: string): SeedArgs {
      return {
        program,
        userId: USER_A,
        input,
        dryRun: false,
        force: false,
        rollback: false,
      };
    }

    it('refuses to proceed when the program belongs to a different user (defense in depth)', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_B, name: 'Not Yours' },
      });
      const csvPath = path.join(backupDir, 'export.csv');
      fs.writeFileSync(csvPath, csvOf([willSeedRow()]));

      await expect(
        runSeed(prisma, baseArgs(program.id, csvPath), backupDir),
      ).rejects.toBeInstanceOf(ProgramOwnershipError);

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(0);
    });

    it('seeds only Will Seed=true rows, mapped correctly, on a program with no existing history', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Fresh Seed' },
      });
      const csvPath = path.join(backupDir, 'export.csv');
      fs.writeFileSync(
        csvPath,
        csvOf([
          willSeedRow({ Lift: 'Squat', TM: '300' }),
          willSeedRow({ Lift: 'Deadlift', TM: '400', 'Will Seed': 'false' }), // hold — must not seed
          willSeedRow({ Lift: 'Bench Press', TM: '200' }),
        ]),
      );

      const result = await runSeed(prisma, baseArgs(program.id, csvPath), backupDir);

      expect(result.mode).toBe('seeded');
      expect(result.existingCount).toBe(0);
      expect(result.writtenCount).toBe(2);
      expect(result.backupPath).toBeNull(); // nothing pre-existing to back up

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { userId: USER_A, program: program.id },
        orderBy: { lift: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.lift).sort()).toEqual(['back-squat', 'bench-press']);
      expect(rows.every((r) => r.reps === 1 && r.source === 'program')).toBe(true);
    });

    it('refuses without --force when the program already has history, and writes nothing', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Already Seeded' },
      });
      await prisma.trainingMaxHistory.create({
        data: {
          userId: USER_A,
          program: program.id,
          lift: 'back-squat',
          weight: 250,
          reps: 1,
          date: new Date('2025-01-01'),
          isPR: false,
          source: 'program',
          goalMet: false,
        },
      });
      const csvPath = path.join(backupDir, 'export.csv');
      fs.writeFileSync(csvPath, csvOf([willSeedRow({ TM: '999' })]));

      await expect(
        runSeed(prisma, baseArgs(program.id, csvPath), backupDir),
      ).rejects.toThrow(/already has 1 history row/);

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.weight).toBe(250); // unchanged — the refusal happened before any write
    });

    it('with --force, backs up then replaces existing history with the new seed (delete-all-then-append)', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Reseed' },
      });
      await prisma.trainingMaxHistory.create({
        data: {
          userId: USER_A,
          program: program.id,
          lift: 'back-squat',
          weight: 250,
          reps: 1,
          date: new Date('2025-01-01'),
          isPR: false,
          source: 'program',
          goalMet: false,
        },
      });
      const csvPath = path.join(backupDir, 'export.csv');
      fs.writeFileSync(csvPath, csvOf([willSeedRow({ TM: '999' })]));

      const result = await runSeed(
        prisma,
        { ...baseArgs(program.id, csvPath), force: true },
        backupDir,
      );

      expect(result.mode).toBe('seeded');
      expect(result.existingCount).toBe(1);
      expect(result.writtenCount).toBe(1);
      expect(result.backupPath).not.toBeNull();
      const backedUp = JSON.parse(fs.readFileSync(result.backupPath as string, 'utf8'));
      expect(backedUp).toHaveLength(1);
      expect(backedUp[0]).toMatchObject({ weight: 250 }); // the OLD row, preserved in the backup

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.weight).toBe(999); // the old row is gone, replaced by the new seed
    });

    it('--dry-run writes nothing and leaves existing history untouched, even when --force is not passed', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Dry Run Only' },
      });
      const csvPath = path.join(backupDir, 'export.csv');
      fs.writeFileSync(csvPath, csvOf([willSeedRow(), willSeedRow({ Lift: 'Deadlift' })]));

      const result = await runSeed(
        prisma,
        { ...baseArgs(program.id, csvPath), dryRun: true },
        backupDir,
      );

      expect(result.mode).toBe('dry-run');
      expect(result.writtenCount).toBe(2);
      expect(result.backupPath).toBeNull();

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(0);
    });

    it('--rollback deletes all history (after backing it up) and appends nothing', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'To Roll Back' },
      });
      await prisma.trainingMaxHistory.createMany({
        data: [
          {
            userId: USER_A,
            program: program.id,
            lift: 'back-squat',
            weight: 300,
            reps: 1,
            date: new Date('2026-01-01'),
            isPR: true,
            source: 'program',
            goalMet: true,
          },
          {
            userId: USER_A,
            program: program.id,
            lift: 'deadlift',
            weight: 400,
            reps: 1,
            date: new Date('2026-01-01'),
            isPR: true,
            source: 'program',
            goalMet: true,
          },
        ],
      });

      const result = await runSeed(
        prisma,
        {
          program: program.id,
          userId: USER_A,
          input: null,
          dryRun: false,
          force: true,
          rollback: true,
        },
        backupDir,
      );

      expect(result.mode).toBe('rolled-back');
      expect(result.existingCount).toBe(2);
      expect(result.writtenCount).toBe(0);
      expect(result.backupPath).not.toBeNull();

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(0);
    });

    it('--rollback --dry-run reports what would happen without deleting anything', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Rollback Preview' },
      });
      await prisma.trainingMaxHistory.create({
        data: {
          userId: USER_A,
          program: program.id,
          lift: 'back-squat',
          weight: 300,
          reps: 1,
          date: new Date('2026-01-01'),
          isPR: true,
          source: 'program',
          goalMet: true,
        },
      });

      const result = await runSeed(
        prisma,
        {
          program: program.id,
          userId: USER_A,
          input: null,
          dryRun: true,
          force: false,
          rollback: true,
        },
        backupDir,
      );

      expect(result.mode).toBe('dry-run');
      expect(result.existingCount).toBe(1);
      expect(result.forceRequired).toBe(true);

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(1); // untouched
    });
  });
});
