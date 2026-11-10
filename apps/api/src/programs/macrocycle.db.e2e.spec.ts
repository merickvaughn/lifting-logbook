// Real-Postgres E2E suite for the macrocycle table (#1197, ADR-042).
//
// Postgres comes from jest.global-setup.js, which exposes LIFTING_TC_DATABASE_URL (the
// restricted lifting_app role) and LIFTING_TC_OWNER_DATABASE_URL (the owner). Seeding,
// cleanup and the backfill call use the owner, as the migrate job does in production; every
// isolation assertion and every HTTP request runs as lifting_app.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../app.module';
import { seedTrainingMaxes } from '../adapters/in-memory/fixtures';
import { PrismaMacrocycleRepository } from '../adapters/prisma/macrocycle.repository';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_TC_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_TC_URL ? describe : describe.skip;
// Only read inside the guarded describe blocks, where both are set.
const OWNER_URL = OWNER_TC_URL ?? '';
const APP_DB_URL = APP_ROLE_URL ?? '';

// See #567: full-suite Windows runs can push a seeding hook past Jest's 5s default.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const PROGRAM = '5-3-1';
const USER_ALICE = 'macrocycle-db-alice';
const USER_BOB = 'macrocycle-db-bob';
const USER_BACKFILL = 'macrocycle-db-backfill';
const USER_BACKFILL_BARE = 'macrocycle-db-backfill-bare';
const USER_RACE = 'macrocycle-db-race';
const USER_ENSURE = 'macrocycle-db-ensure';
const USERS = [USER_ALICE, USER_BOB, USER_BACKFILL, USER_BACKFILL_BARE, USER_RACE, USER_ENSURE];

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/** Thrown to roll back an owner transaction once its assertions are done. */
class Rollback extends Error {}

async function asUser<T>(client: PrismaClient, userId: string | null, body: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return client.$transaction(async (tx) => {
    if (userId !== null) await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    return body(tx as unknown as PrismaClient);
  });
}

async function cleanup(owner: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await owner.macrocycle.deleteMany({ where });
  await owner.liftRecord.deleteMany({ where });
  await owner.macrocycleDashboard.deleteMany({ where });
  await owner.macrocycleScheduledWorkout.deleteMany({ where });
  await owner.workoutDateOverride.deleteMany({ where });
  await owner.workoutSkipOverride.deleteMany({ where });
  await owner.workoutLiftOverride.deleteMany({ where });
  await owner.focusDayState.deleteMany({ where });
  await owner.trainingMax.deleteMany({ where });
  await owner.trainingMaxHistory.deleteMany({ where });
}

describeOrSkip('macrocycle table (e2e, lifting_app role)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
    await cleanup(owner);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup(owner).catch(() => undefined);
    await appDb?.$disconnect().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  describe('row-level security', () => {
    beforeAll(async () => {
      await owner.macrocycle.createMany({
        data: [USER_ALICE, USER_BOB].map((userId) => ({
          userId,
          program: PROGRAM,
          macrocycleNum: 1,
          startDate: day('2026-01-05'),
          status: 'completed',
          origin: 'imported',
        })),
      });
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('the app-role connection does not bypass RLS', async () => {
      const rows = await appDb.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('reads only the caller\'s rows on an unscoped query, and none with no user set', async () => {
      const rows = await asUser(appDb, USER_ALICE, (tx) => tx.macrocycle.findMany({ where: { userId: { in: USERS } } }));
      expect(rows.map((row) => row.userId)).toEqual([USER_ALICE]);
      expect(await asUser(appDb, null, (tx) => tx.macrocycle.count())).toBe(0);
    });

    it('cannot write another user\'s rows', async () => {
      await expect(
        asUser(appDb, USER_ALICE, (tx) =>
          tx.macrocycle.create({
            data: { userId: USER_BOB, program: PROGRAM, macrocycleNum: 2, startDate: day('2026-02-02'), status: 'in-progress', origin: 'live' },
          }),
        ),
      ).rejects.toThrow();
      const updated = await asUser(appDb, USER_ALICE, (tx) => tx.macrocycle.updateMany({ data: { status: 'abandoned' } }));
      expect(updated.count).toBe(1);
      const deleted = await asUser(appDb, USER_ALICE, (tx) => tx.macrocycle.deleteMany());
      expect(deleted.count).toBe(1);
      const bobRow = await owner.macrocycle.findFirstOrThrow({ where: { userId: USER_BOB } });
      expect(bobRow.status).toBe('completed');
    });
  });

  describe('backfill function', () => {
    beforeAll(async () => {
      const user = USER_BACKFILL;
      // 1 and 2 have sets; 1 already has a row, which the backfill must leave alone.
      await owner.liftRecord.createMany({
        data: [
          { userId: user, program: PROGRAM, macrocycleNum: 1, workoutNum: 1, date: day('2026-01-05'), lift: 'Squat', setNum: 1, weight: 200, reps: 5 },
          { userId: user, program: PROGRAM, macrocycleNum: 1, workoutNum: 4, date: day('2026-01-20'), lift: 'Squat', setNum: 1, weight: 200, reps: 5 },
          { userId: user, program: PROGRAM, macrocycleNum: 2, workoutNum: 1, date: day('2026-02-02'), lift: 'Squat', setNum: 1, weight: 210, reps: 5 },
          { userId: user, program: PROGRAM, macrocycleNum: 2, workoutNum: 2, date: day('2026-02-10'), lift: 'Squat', setNum: 1, weight: 210, reps: 5 },
        ],
      });
      await owner.macrocycle.create({
        data: { userId: user, program: PROGRAM, macrocycleNum: 1, startDate: day('2025-12-01'), status: 'completed', origin: 'imported' },
      });
      // 3 has only a schedule.
      await owner.macrocycleScheduledWorkout.create({
        data: { userId: user, program: PROGRAM, macrocycleNum: 3, workoutNum: 1, weekNum: 1, scheduledDate: day('2026-03-02') },
      });
      // 4 is current, with nothing logged yet.
      await owner.macrocycleDashboard.create({
        data: {
          userId: user,
          program: PROGRAM,
          macrocycleUnit: 'Week',
          macrocycleNum: 4,
          macrocycleDate: day('2026-06-01'),
          sheetName: `${PROGRAM}_Cycle_4_20260601`,
          macrocycleStartWeekday: 'Monday',
        },
      });
      // 5 to 7 have only a skip, a focus state or a lift override, so they date from 4.
      await owner.workoutSkipOverride.create({ data: { userId: user, program: PROGRAM, macrocycleNum: 5, workoutNum: 2 } });
      await owner.focusDayState.create({ data: { userId: user, program: PROGRAM, macrocycleNum: 6, workoutNum: 1, state: {} } });
      await owner.workoutLiftOverride.create({
        data: { userId: user, program: PROGRAM, macrocycleNum: 7, workoutNum: 1, lift: 'Dips', action: 'add' },
      });
      // A user whose only number has nothing to date it.
      await owner.workoutDateOverride.create({
        data: { userId: USER_BACKFILL_BARE, program: PROGRAM, macrocycleNum: 2, workoutNum: 1, newDate: day('2026-04-01') },
      });
    }, DB_E2E_HOOK_TIMEOUT_MS);

    /**
     * The function reads every user's rows, and other DB suites share this database, so it
     * runs in an owner transaction that's rolled back once `body` has read what it needs.
     */
    async function withBackfill(body: (tx: PrismaClient) => Promise<void>): Promise<void> {
      try {
        await owner.$transaction(
          async (tx) => {
            // Another suite's uncommitted row fails this fast instead of stalling both.
            await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
            await tx.$queryRaw`SELECT "macrocycle_backfill_rows"()`;
            await body(tx as unknown as PrismaClient);
            throw new Rollback();
          },
          { timeout: DB_E2E_HOOK_TIMEOUT_MS },
        );
      } catch (err) {
        // A failed assertion surfaces as itself, with its diff.
        if (err instanceof Rollback) return;
        throw err;
      }
      throw new Error('the backfill transaction committed');
    }

    const rowsFor = (tx: PrismaClient, userId: string) =>
      tx.macrocycle.findMany({ where: { userId, program: PROGRAM }, orderBy: { macrocycleNum: 'asc' } });

    it('gives every stored number one row, without changing a row that exists', async () => {
      await withBackfill(async (tx) => {
        const rows = await rowsFor(tx, USER_BACKFILL);
        expect(
          rows.map((row) => ({
            num: row.macrocycleNum,
            start: isoDay(row.startDate),
            end: isoDay(row.endDate),
            status: row.status,
            origin: row.origin,
          })),
        ).toEqual([
          { num: 1, start: '2025-12-01', end: null, status: 'completed', origin: 'imported' },
          { num: 2, start: '2026-02-02', end: '2026-02-10', status: 'unknown', origin: 'legacy' },
          { num: 3, start: '2026-03-02', end: null, status: 'unknown', origin: 'legacy' },
          { num: 4, start: '2026-06-01', end: null, status: 'in-progress', origin: 'live' },
          { num: 5, start: '2026-06-01', end: null, status: 'unknown', origin: 'legacy' },
          { num: 6, start: '2026-06-01', end: null, status: 'unknown', origin: 'legacy' },
          { num: 7, start: '2026-06-01', end: null, status: 'unknown', origin: 'legacy' },
        ]);
      });
    });

    it('dates a number with nothing to go on from today', async () => {
      await withBackfill(async (tx) => {
        const rows = await rowsFor(tx, USER_BACKFILL_BARE);
        const today = await tx.$queryRaw<Array<{ today: Date }>>`SELECT CURRENT_DATE AS today`;
        expect(rows.map((row) => [row.macrocycleNum, isoDay(row.startDate)])).toEqual([[2, isoDay(today[0]?.today ?? null)]]);
      });
    });

    it('changes nothing when it runs again', async () => {
      await withBackfill(async (tx) => {
        const first = await rowsFor(tx, USER_BACKFILL);
        await tx.$queryRaw`SELECT "macrocycle_backfill_rows"()`;
        expect(await rowsFor(tx, USER_BACKFILL)).toEqual(first);
      });
    });

    it('the app role cannot run it', async () => {
      await expect(asUser(appDb, USER_BACKFILL, (tx) => tx.$queryRaw`SELECT "macrocycle_backfill_rows"()`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});

describeOrSkip('macrocycle numbering under concurrency (full app, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanup(owner);
    process.env.DATABASE_URL = APP_DB_URL;
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup(owner).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  const inject = (method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: { authorization: `Bearer ${USER_RACE}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body ?? {}),
    });

  /**
   * Waits until a backend is blocked by `pid`'s locks. Other DB suites share this database,
   * so any other lock wait doesn't count.
   */
  async function waitForBlockedBy(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await owner.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`nothing ever blocked on backend ${pid}`);
  }

  /**
   * Runs `insert` in a transaction it holds open until the returned `release` is called, so
   * no other transaction can see the row. Resolves once the row is in, with the backend's pid.
   */
  async function holdOpen(
    client: PrismaClient,
    userId: string | null,
    insert: (tx: PrismaClient) => Promise<unknown>,
  ): Promise<{ pid: number; release: () => void; done: Promise<void> }> {
    let release = () => undefined as void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted = (_pid: number) => undefined as void;
    const insertedPid = new Promise<number>((resolve) => {
      inserted = resolve;
    });
    const done = client.$transaction(
      async (tx) => {
        if (userId !== null) await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
        await insert(tx as unknown as PrismaClient);
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        inserted(rows[0]?.pid ?? -1);
        await released;
      },
      { timeout: DB_E2E_HOOK_TIMEOUT_MS },
    );
    // A failed insert rejects `done` before the pid arrives.
    const pid = await Promise.race([insertedPid, done.then(() => -1)]);
    return { pid, release, done };
  }

  it('a number taken while the next macrocycle starts is a 409, with nothing written', async () => {
    expect((await inject('POST', `/programs/${PROGRAM}/macrocycles/initialize`, { macrocycleDate: '2026-01-05' })).statusCode).toBe(201);
    await owner.trainingMax.createMany({
      data: seedTrainingMaxes().map((max) => ({ userId: USER_RACE, program: PROGRAM, ...max })),
    });

    // The harness takes number 2 before the request starts, in a transaction it holds open.
    const harness = await holdOpen(owner, null, (tx) =>
      tx.macrocycle.create({
        data: { userId: USER_RACE, program: PROGRAM, macrocycleNum: 2, startDate: day('2026-02-02'), status: 'in-progress', origin: 'live' },
      }),
    );

    const startNext = inject('POST', `/programs/${PROGRAM}/macrocycles`);
    await waitForBlockedBy(harness.pid);
    harness.release();
    await harness.done;
    const res = await startNext;

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('macrocycle-number-taken');
    const dashboard = await owner.macrocycleDashboard.findFirstOrThrow({ where: { userId: USER_RACE, program: PROGRAM } });
    expect(dashboard.macrocycleNum).toBe(1);
    const rows = await owner.macrocycle.findMany({ where: { userId: USER_RACE, program: PROGRAM }, orderBy: { macrocycleNum: 'asc' } });
    expect(rows.map((row) => [row.macrocycleNum, row.status, isoDay(row.endDate)])).toEqual([
      [1, 'in-progress', null],
      [2, 'in-progress', null],
    ]);
    expect(await owner.macrocycleScheduledWorkout.count({ where: { userId: USER_RACE, macrocycleNum: { gt: 1 } } })).toBe(0);
  });

  it('two requests ensuring the same row both succeed, leaving one row', async () => {
    const appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
    const row = { program: PROGRAM, macrocycleNum: 1, startDate: day('2026-03-02'), status: 'in-progress', origin: 'live' } as const;
    const ensure = (tx: PrismaClient) => new PrismaMacrocycleRepository(tx, USER_ENSURE).ensure([row]);
    try {
      const first = await holdOpen(appDb, USER_ENSURE, ensure);
      const second = asUser(appDb, USER_ENSURE, ensure);
      await waitForBlockedBy(first.pid);
      first.release();
      await expect(Promise.all([first.done, second])).resolves.toEqual([undefined, undefined]);
    } finally {
      await appDb.$disconnect();
    }
    expect(await owner.macrocycle.count({ where: { userId: USER_ENSURE, program: PROGRAM } })).toBe(1);
  });
});
