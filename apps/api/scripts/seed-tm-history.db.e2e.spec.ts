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
  REQUIRED_COLUMNS,
  runSeed,
  SeedArgs,
  verifyProgramOwnership,
} from './seed-tm-history';
import { PrismaTrainingMaxHistoryRepository } from '../src/adapters/prisma/training-max-history.repository';

const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
// Skip only when globalSetup did not provision a DB (e.g. Docker unavailable
// and not running in CI) — matches programs.db.e2e.spec.ts's pattern.
const describeOrSkip = OWNER_DATABASE_URL ? describe : describe.skip;

// Applied to every hook that actually touches Postgres (beforeEach/afterAll)
// — matching programs.db.e2e.spec.ts's own placement (its comment there
// explains #567: these hooks intermittently trip Jest's 5s default under a
// full-suite Windows `turbo run test`, since apps/api/jest.config.js does
// not extend the win32-capped base config). Deliberately NOT on beforeAll
// here, which only constructs a PrismaClient (Prisma connects lazily) and
// does no DB work of its own.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_A = 'seed-tm-history-e2e-user-a';
const USER_B = 'seed-tm-history-e2e-user-b';

/** Fails loudly and narrows the type — the one idiom this file uses for
 * "an assertion already proved this is non-null, now tell the compiler."
 * Replaces a mix of `!` and `as` that either "solved" the same problem
 * differently in different spots, or, in `expect(x).not.toBeNull()`'s
 * case, doesn't actually narrow at all (Jest's matchers have no type-level
 * effect) — so on an unexpected null both `!` and `as` produce a confusing
 * failure the first time they're actually wrong, whereas this throws a
 * named error immediately. */
function assertNotNull<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`expected ${what} to be non-null`);
  return value;
}

async function cleanTestUsers(prisma: PrismaClient): Promise<void> {
  await prisma.trainingMaxHistory.deleteMany({
    where: { userId: { in: [USER_A, USER_B] } },
  });
  await prisma.customProgram.deleteMany({
    where: { userId: { in: [USER_A, USER_B] } },
  });
}

const tmpDirs: string[] = [];
function tmpBackupDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-tm-history-e2e-'));
  tmpDirs.push(dir);
  return dir;
}

function csvOf(rows: Record<string, string>[]): string {
  const lines = [REQUIRED_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(REQUIRED_COLUMNS.map((h) => row[h] ?? '').join(','));
  }
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
  });

  beforeEach(async () => {
    await cleanTestUsers(prisma);
    backupDir = tmpBackupDir();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await cleanTestUsers(prisma);
    await prisma.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

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

    it('logs the connected role/database identity for audit purposes', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Identity Log' },
      });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await verifyProgramOwnership(prisma, program.id, USER_A);
        expect(
          logSpy.mock.calls.some((call) =>
            String(call[0]).startsWith('Connected as '),
          ),
        ).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // backupExistingHistory is now fs/JSON-only (no Prisma) and is covered at
  // the function level in seed-tm-history.spec.ts, including the envelope
  // shape and read-back verification. The real-DB round trip (a Prisma-
  // fetched TrainingMaxHistoryEntry[] all the way through to a restorable
  // file) is exercised by the "--restore" test below via runSeed, which is
  // this suite's reason to exist — no separate describe block needed here.

  describe('runSeed', () => {
    function baseArgs(program: string, input: string): SeedArgs {
      return {
        mode: 'seed',
        program,
        userId: USER_A,
        input,
        dryRun: false,
        force: false,
        backupDir,
      };
    }

    it('refuses to proceed when the program belongs to a different user (defense in depth)', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_B, name: 'Not Yours' },
      });
      const csvPath = path.join(backupDir, 'export.csv');
      fs.writeFileSync(csvPath, csvOf([willSeedRow()]));

      await expect(
        runSeed(prisma, baseArgs(program.id, csvPath)),
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

      const result = await runSeed(prisma, baseArgs(program.id, csvPath));

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

    it('refuses a seed that would write zero rows, rather than silently wiping existing history', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'All Holds' },
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
      // Every row is a hold (Will Seed=false) — a plausible wrong-file or
      // wrong-export-state mistake, not itself invalid CSV.
      fs.writeFileSync(csvPath, csvOf([willSeedRow({ 'Will Seed': 'false' })]));

      await expect(
        runSeed(prisma, { ...baseArgs(program.id, csvPath), force: true }),
      ).rejects.toThrow(/zero rows to seed/);

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.weight).toBe(250); // untouched — refused before any delete
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
        runSeed(prisma, baseArgs(program.id, csvPath)),
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
      );

      expect(result.mode).toBe('seeded');
      expect(result.existingCount).toBe(1);
      expect(result.writtenCount).toBe(1);
      const backupPath = assertNotNull(result.backupPath, 'result.backupPath');
      const backedUp = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      expect(backedUp.entries).toHaveLength(1);
      expect(backedUp.entries[0]).toMatchObject({ weight: 250 }); // the OLD row, preserved in the backup

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
      );

      expect(result.mode).toBe('dry-run');
      expect(result.writtenCount).toBe(2);
      expect(result.backupPath).toBeNull();

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(0);
    });

    it('--dry-run validates rows the same way a real run would (throws on a bad row, writes nothing)', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Dry Run Validates' },
      });
      const csvPath = path.join(backupDir, 'export.csv');
      fs.writeFileSync(csvPath, csvOf([willSeedRow({ TM: 'not-a-number' })]));

      await expect(
        runSeed(prisma, { ...baseArgs(program.id, csvPath), dryRun: true }),
      ).rejects.toThrow(/invalid TM/);

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(0);
    });

    it('rolls back the whole write if appendHistoryEntries fails after deleteAllHistory has run', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Transactional Safety' },
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
      // 'source' is DB-CHECK-constrained to 'test'|'program' — appendHistoryEntries
      // always writes 'program' (see mapRowToEntry), so provoke the failure a
      // different way: a lift name long enough to violate no column length
      // constraint is fragile to rely on, so instead simulate the failure
      // directly against the real repository to prove the transaction
      // boundary, independent of finding a naturally-failing row shape.
      fs.writeFileSync(csvPath, csvOf([willSeedRow({ TM: '999' })]));

      const txSpy = jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(async () => {
          throw new Error('simulated append failure');
        });
      try {
        await expect(
          runSeed(prisma, { ...baseArgs(program.id, csvPath), force: true }),
        ).rejects.toThrow('simulated append failure');
      } finally {
        txSpy.mockRestore();
      }

      // The pre-existing row must still be there — Prisma's real
      // $transaction would have rolled back the delete along with the
      // failed append; this test proves runSeed routes both calls through
      // $transaction at all (a regression back to two independent
      // statements would still pass every other test in this file, since
      // they don't inject a failure between the two calls).
      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.weight).toBe(250);
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
          mode: 'rollback',
          program: program.id,
          userId: USER_A,
          dryRun: false,
          force: true,
          backupDir,
        },
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
          mode: 'rollback',
          program: program.id,
          userId: USER_A,
          dryRun: true,
          force: false,
          backupDir,
        },
      );

      expect(result.mode).toBe('dry-run');
      expect(result.existingCount).toBe(1);
      expect(result.forceRequired).toBe(true);

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(1); // untouched
    });

    it('--restore replaces current history with a previously-captured backup file', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Restore Target' },
      });
      // Seed once, capturing a backup of the (empty) prior state, so we have
      // a real backup file shaped exactly like backupExistingHistory writes.
      const seeded = await prisma.trainingMaxHistory.create({
        data: {
          userId: USER_A,
          program: program.id,
          lift: 'back-squat',
          weight: 305,
          reps: 1,
          date: new Date('2026-03-01'),
          isPR: true,
          source: 'program',
          goalMet: true,
        },
      });
      const repo = new PrismaTrainingMaxHistoryRepository(prisma, USER_A);
      const existingForBackup = await repo.getHistory(program.id);
      const backup = assertNotNull(
        await backupExistingHistory(existingForBackup, program.id, USER_A, backupDir),
        'backup of seeded row',
      );
      expect(backup.count).toBe(1);

      // Simulate a bad reseed the operator wants to undo.
      await prisma.trainingMaxHistory.deleteMany({ where: { program: program.id } });
      await prisma.trainingMaxHistory.create({
        data: {
          userId: USER_A,
          program: program.id,
          lift: 'deadlift',
          weight: 1,
          reps: 1,
          date: new Date('2026-01-01'),
          isPR: false,
          source: 'program',
          goalMet: false,
        },
      });

      const result = await runSeed(
        prisma,
        {
          mode: 'restore',
          program: program.id,
          userId: USER_A,
          restorePath: backup.path,
          dryRun: false,
          force: true,
          backupDir,
        },
      );

      expect(result.mode).toBe('restored');
      expect(result.writtenCount).toBe(1);

      const rows = await prisma.trainingMaxHistory.findMany({
        where: { program: program.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lift).toBe('back-squat');
      expect(rows[0]?.weight).toBe(305);
      expect(rows[0]?.id).not.toBe(seeded.id); // restored as a new row, not the literal old id
    });

    it('flags a cross-user data anomaly (rows under this program but a different userId) rather than silently under-counting', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Anomaly' },
      });
      // A row for this program under a *different* user — not a state the
      // application itself should ever produce, but exactly the kind of
      // anomaly only the RLS-bypassing connection this script uses can see.
      await prisma.trainingMaxHistory.create({
        data: {
          userId: USER_B,
          program: program.id,
          lift: 'back-squat',
          weight: 1,
          reps: 1,
          date: new Date('2025-01-01'),
          isPR: false,
          source: 'program',
          goalMet: false,
        },
      });

      await expect(
        verifyProgramOwnership(prisma, program.id, USER_A),
      ).rejects.toThrow(/some rows exist under a different userId/);
    });

    it('refuses a CSV whose Will Seed=true rows span more than one Program value', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Multi-Program Guard' },
      });
      const csvPath = path.join(backupDir, 'export.csv');
      fs.writeFileSync(
        csvPath,
        csvOf([willSeedRow({ Program: 'RPT' }), willSeedRow({ Program: 'nSuns', Lift: 'Bench Press' })]),
      );

      await expect(
        runSeed(prisma, baseArgs(program.id, csvPath)),
      ).rejects.toThrow(/different Program values/);

      const rows = await prisma.trainingMaxHistory.findMany({ where: { program: program.id } });
      expect(rows).toHaveLength(0);
    });

    it('the --force-required refusal is mode-aware: --rollback does not get the seed-oriented message', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Rollback Message' },
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

      // The runbook's documented rollback invocation passes no --force —
      // this is the exact command it tells operators to run, pinned here so
      // a future divergence between the script and the runbook fails a test
      // instead of surfacing mid-procedure. One call, two assertions on the
      // same captured error, rather than two separate rejecting calls.
      let caught: Error | undefined;
      try {
        await runSeed(prisma, {
          mode: 'rollback',
          program: program.id,
          userId: USER_A,
          dryRun: false,
          force: false,
          backupDir,
        });
      } catch (e) {
        caught = e instanceof Error ? e : undefined;
      }
      expect(caught?.message).toMatch(/--rollback will delete 1 existing history row/);
      expect(caught?.message).not.toMatch(/unexpected at the normal Phase 2B timing/);

      const rows = await prisma.trainingMaxHistory.findMany({ where: { program: program.id } });
      expect(rows).toHaveLength(1); // refused before any delete
    });

    it('--restore refuses a backup captured for a different program', async () => {
      const programA = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Backup Source' },
      });
      const programB = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Restore Target (Wrong)' },
      });
      await prisma.trainingMaxHistory.create({
        data: {
          userId: USER_A,
          program: programA.id,
          lift: 'back-squat',
          weight: 300,
          reps: 1,
          date: new Date('2026-01-01'),
          isPR: true,
          source: 'program',
          goalMet: true,
        },
      });
      const repo = new PrismaTrainingMaxHistoryRepository(prisma, USER_A);
      const existingForBackup = await repo.getHistory(programA.id);
      const backup = assertNotNull(
        await backupExistingHistory(existingForBackup, programA.id, USER_A, backupDir),
        'backup of program A',
      );

      await expect(
        runSeed(prisma, {
          mode: 'restore',
          program: programB.id,
          userId: USER_A,
          restorePath: backup.path,
          dryRun: false,
          force: true,
          backupDir,
        }),
      ).rejects.toThrow(/was captured for program/);

      const rowsB = await prisma.trainingMaxHistory.findMany({ where: { program: programB.id } });
      expect(rowsB).toHaveLength(0);
    });

    it('--restore refuses an empty backup file rather than silently wiping current history', async () => {
      const program = await prisma.customProgram.create({
        data: { userId: USER_A, name: 'Restore Empty Guard' },
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
      const emptyBackupPath = path.join(backupDir, 'empty-backup.json');
      fs.writeFileSync(
        emptyBackupPath,
        JSON.stringify({
          program: program.id,
          userId: USER_A,
          capturedAt: new Date().toISOString(),
          entries: [],
        }),
      );

      await expect(
        runSeed(prisma, {
          mode: 'restore',
          program: program.id,
          userId: USER_A,
          restorePath: emptyBackupPath,
          dryRun: false,
          force: true,
          backupDir,
        }),
      ).rejects.toThrow(/zero rows to seed/);

      const rows = await prisma.trainingMaxHistory.findMany({ where: { program: program.id } });
      expect(rows).toHaveLength(1); // untouched — refused before any delete
    });
  });
});
