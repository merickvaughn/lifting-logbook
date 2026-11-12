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
import { Prisma, PrismaClient } from '@prisma/client';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { liftRecordNaturalKey } from '@lifting-logbook/core';
import { emptyFocusDayState, MACROCYCLE_ID_HEADER } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { seedTrainingMaxes } from '../adapters/in-memory/fixtures';
import multipart from '@fastify/multipart';
import {
  MACROCYCLE_LOCK_NAMESPACE,
  NUMBERED_TABLES,
  PrismaMacrocycleRepository,
} from '../adapters/prisma/macrocycle.repository';
import { MacrocycleNumberConflictError } from '../ports/errors';
import { IMPORT_LOCK_WAIT_MS, legacyRowsPreImage } from './macrocycle-history.util';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

const spans = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }).register();

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
const USER_LOCK = 'macrocycle-db-lock';
const USER_RENUMBER = 'macrocycle-db-renumber';
const USER_RENUMBER_OTHER = 'macrocycle-db-renumber-other';
const USER_RENUMBER_ATOMIC = 'macrocycle-db-renumber-atomic';
const USER_RENUMBER_BATCH = 'macrocycle-db-renumber-batch';
const USER_RENUMBER_LOCK = 'macrocycle-db-renumber-lock';
const USER_RENUMBER_ORPHAN = 'macrocycle-db-renumber-orphan';
const USER_RENUMBER_STALE = 'macrocycle-db-renumber-stale';
const USER_RENUMBER_UNSTARTED = 'macrocycle-db-renumber-unstarted';
const USER_RENUMBER_UPGRADE = 'macrocycle-db-renumber-upgrade';
const USER_RENUMBER_DEADLOCK = 'macrocycle-db-renumber-deadlock';
const USER_HISTORY_ORDER = 'macrocycle-db-history-order';
const USER_HISTORY_REVERSE = 'macrocycle-db-history-reverse';
const USER_HISTORY_LATER_IMPORT = 'macrocycle-db-history-later-import';
const USER_HISTORY_NEW_ROW = 'macrocycle-db-history-new-row';
const USER_HISTORY_UNDO = 'macrocycle-db-history-undo';
const USER_HISTORY_WINDOW = 'macrocycle-db-history-window';
const USER_HISTORY_NEGATIVE = 'macrocycle-db-history-negative';
const USER_HISTORY_UNSTARTED = 'macrocycle-db-history-unstarted';
const USER_HISTORY_LOCK = 'macrocycle-db-history-lock';
const USER_HISTORY_NO_WAIT = 'macrocycle-db-history-no-wait';
const USERS = [
  USER_HISTORY_NO_WAIT,
  USER_HISTORY_NEGATIVE,
  USER_HISTORY_UNSTARTED,
  USER_HISTORY_LOCK,
  USER_HISTORY_ORDER,
  USER_HISTORY_REVERSE,
  USER_HISTORY_LATER_IMPORT,
  USER_HISTORY_NEW_ROW,
  USER_HISTORY_UNDO,
  USER_HISTORY_WINDOW,
  USER_RENUMBER_UNSTARTED,
  USER_RENUMBER_UPGRADE,
  USER_RENUMBER_DEADLOCK,
  USER_RENUMBER_ORPHAN,
  USER_RENUMBER_STALE,
  USER_ALICE,
  USER_BOB,
  USER_BACKFILL,
  USER_BACKFILL_BARE,
  USER_RACE,
  USER_ENSURE,
  USER_LOCK,
  USER_RENUMBER,
  USER_RENUMBER_OTHER,
  USER_RENUMBER_ATOMIC,
  USER_RENUMBER_BATCH,
  USER_RENUMBER_LOCK,
];

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
  await owner.importBatch.deleteMany({ where });
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
    async function withBackfill(
      body: (tx: PrismaClient) => Promise<void>,
      fn: 'macrocycle_backfill_rows' | 'macrocycle_backfill_window_rows' = 'macrocycle_backfill_rows',
    ): Promise<void> {
      try {
        await owner.$transaction(
          async (tx) => {
            // Another suite's uncommitted row fails this fast instead of stalling both.
            await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
            await tx.$queryRawUnsafe(`SELECT "${fn}"()`);
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

    it("the migration's rerun adds no row for numbers past every macrocycle that hold no sets (#1200)", async () => {
      // 5 to 7 sit past the dashboard's 4 with no sets: saved ahead of the next macrocycle, as a
      // focus state saved before initializing is. The bare user's program has no macrocycle at all.
      await withBackfill(async (tx) => {
        expect((await rowsFor(tx, USER_BACKFILL)).map((row) => [row.macrocycleNum, row.origin])).toEqual([
          [1, 'imported'],
          [2, 'legacy'],
          [3, 'legacy'],
          [4, 'live'],
        ]);
        expect(await rowsFor(tx, USER_BACKFILL_BARE)).toEqual([]);
      }, 'macrocycle_backfill_window_rows');
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
    await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
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

  const injectAs = (user: string, method: string, url: string, body?: unknown, macrocycleId?: string) =>
    app.getHttpAdapter().getInstance().inject({
      method: method as 'GET',
      url,
      headers: {
        authorization: `Bearer ${user}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(macrocycleId === undefined ? {} : { [MACROCYCLE_ID_HEADER]: macrocycleId }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const inject = (method: 'GET' | 'POST', url: string, body?: unknown) => injectAs(USER_RACE, method, url, body ?? {});

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

  describe('the macrocycle write lock (#1198)', () => {
    const base = `/programs/${PROGRAM}`;
    let macrocycleId = '';
    let recordId = '';

    beforeAll(async () => {
      expect((await injectAs(USER_LOCK, 'POST', `${base}/macrocycles/initialize`, { macrocycleDate: '2026-01-05' })).statusCode).toBe(201);
      await owner.trainingMax.createMany({
        data: seedTrainingMaxes().map((max) => ({ userId: USER_LOCK, program: PROGRAM, ...max })),
      });
      macrocycleId = (await injectAs(USER_LOCK, 'GET', `${base}/workouts/1`)).json().macrocycleId;
      const logged = await injectAs(USER_LOCK, 'POST', `${base}/lift-records`, logBody(1), macrocycleId);
      expect(logged.statusCode).toBe(201);
      recordId = logged.json().id;
    }, DB_E2E_HOOK_TIMEOUT_MS);

    function logBody(setNum: number) {
      return { macrocycleNum: 1, workoutNum: 1, date: '2026-01-05', lift: 'Squat', setNum, weight: 225, reps: 5 };
    }

    const pageWrites = () => [
      { method: 'POST', url: `${base}/lift-records`, body: logBody(2) },
      { method: 'PATCH', url: `${base}/lift-records/${encodeURIComponent(recordId)}`, body: { reps: 6 } },
      { method: 'POST', url: `${base}/macrocycles/1/workouts/1/lift-overrides`, body: { lift: 'Bench Press', action: 'remove' } },
      { method: 'DELETE', url: `${base}/macrocycles/1/workouts/1/lift-overrides/Bench%20Press` },
      { method: 'PATCH', url: `${base}/macrocycles/1/workouts/1/reschedule`, body: { newDate: '2026-01-07' } },
      { method: 'POST', url: `${base}/macrocycles/1/workouts/1/skip`, body: {} },
      { method: 'DELETE', url: `${base}/macrocycles/1/workouts/1/skip` },
      { method: 'PUT', url: `${base}/workouts/1/focus-state`, body: { ...emptyFocusDayState(), dismissed: true } },
      { method: 'POST', url: `${base}/macrocycles`, body: { fromMacrocycleNum: 1 } },
    ];

    /**
     * A one-set file dated `date`; each test imports its own, so none depends on another. The
     * set lands in a new legacy macrocycle starting that day, at whatever number is next (#1199).
     */
    const upload = (url: string, date = '2025-03-03') => {
      const boundary = '----MacrocycleLockBoundary';
      return app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${USER_LOCK}` },
        payload: [
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="upload.csv"',
          'Content-Type: text/csv',
          '',
          `Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes\n5-3-1,4,1,${date},Squat,1,200,5,`,
          `--${boundary}--`,
        ].join('\r\n'),
      });
    };
    const commitImport = `${base}/import?mode=commit&destination=lift-records`;
    const imports = [`${base}/lift-records/import`, commitImport];
    /** Each import waits out the lock before its 409, so a test running several needs room. */
    const LOCKED_TEST_TIMEOUT_MS = 4 * IMPORT_LOCK_WAIT_MS + DB_E2E_HOOK_TIMEOUT_MS;

    /** Holds the user's lock from another connection, as #1199's renumbering will. */
    const holdLock = (mode: 'shared' | 'exclusive') =>
      holdOpen(owner, null, (tx) =>
        mode === 'shared'
          ? tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${USER_LOCK}, ${MACROCYCLE_LOCK_NAMESPACE}))::text`
          : tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${USER_LOCK}, ${MACROCYCLE_LOCK_NAMESPACE}))::text`,
      );

    const storedSets = () => owner.liftRecord.count({ where: { userId: USER_LOCK } });
    const expectBusy = (url: string, res: { statusCode: number; json: () => { code?: string } }) =>
      expect({ url, status: res.statusCode, code: res.json().code }).toEqual({ url, status: 409, code: 'macrocycle-busy' });

    it('answers every macrocycle write with 409 import-in-progress while an import holds it, and imports with 409 macrocycle-busy once their wait runs out, writing nothing', async () => {
      const before = await storedSets();
      const harness = await holdLock('exclusive');
      try {
        const macrocycleWrites = [
          { method: 'POST', url: `${base}/macrocycles`, body: {} },
          { method: 'POST', url: `${base}/macrocycles/initialize`, body: { macrocycleDate: '2026-01-05' } },
          { method: 'DELETE', url: `${base}/macrocycles/current` },
        ];
        for (const write of [...pageWrites(), ...macrocycleWrites]) {
          const res = await injectAs(USER_LOCK, write.method, write.url, write.body, macrocycleId);
          expect({ url: write.url, status: res.statusCode, code: res.json().code }).toEqual({
            url: write.url,
            status: 409,
            code: 'import-in-progress',
          });
        }
        for (const url of imports) {
          const started = Date.now();
          expectBusy(url, await upload(url));
          // It waited for the lock rather than failing at once.
          expect(Date.now() - started).toBeGreaterThanOrEqual(IMPORT_LOCK_WAIT_MS - 500);
        }
      } finally {
        harness.release();
        await harness.done;
      }
      expect(await storedSets()).toBe(before);
      expect(await owner.workoutSkipOverride.count({ where: { userId: USER_LOCK } })).toBe(0);
      expect((await owner.macrocycle.findMany({ where: { userId: USER_LOCK } })).map((row) => row.macrocycleNum)).toEqual([1]);
      expect((await owner.macrocycleDashboard.findFirstOrThrow({ where: { userId: USER_LOCK } })).macrocycleNum).toBe(1);
    }, LOCKED_TEST_TIMEOUT_MS);

    it('lets page writes share it, and an import waits for them to finish', async () => {
      const harness = await holdLock('shared');
      let released = false;
      try {
        const write = await injectAs(USER_LOCK, 'POST', `${base}/macrocycles/1/workouts/1/skip`, {}, macrocycleId);
        expect(write.statusCode).toBe(204);
        const pending = upload(commitImport);
        await waitForBlockedBy(harness.pid);
        harness.release();
        released = true;
        const res = await pending;
        expect(res.statusCode).toBe(200);
      } finally {
        if (!released) harness.release();
        await harness.done;
      }
      expect(await owner.macrocycle.count({ where: { userId: USER_LOCK, startDate: day('2025-03-03') } })).toBe(1);
    }, LOCKED_TEST_TIMEOUT_MS);

    // Postgres queues a no-wait shared request behind a waiting exclusive one, so while an
    // import waits for page writes, a new page write is refused as if the import held the lock.
    it('answers a page write with 409 import-in-progress, and a workout read with no id, while an import waits for the lock', async () => {
      const harness = await holdLock('shared');
      let released = false;
      try {
        const pending = upload(commitImport, '2025-06-02');
        await waitForBlockedBy(harness.pid);
        const write = await injectAs(USER_LOCK, 'POST', `${base}/lift-records`, logBody(3), macrocycleId);
        expect({ status: write.statusCode, code: write.json().code }).toEqual({ status: 409, code: 'import-in-progress' });
        const read = await injectAs(USER_LOCK, 'GET', `${base}/workouts/1`);
        expect(read.statusCode).toBe(200);
        expect(read.json().macrocycleId).toBeUndefined();
        harness.release();
        released = true;
        expect((await pending).statusCode).toBe(200);
      } finally {
        if (!released) harness.release();
        await harness.done;
      }
      expect(await owner.macrocycle.count({ where: { userId: USER_LOCK, startDate: day('2025-06-02') } })).toBe(1);
    }, LOCKED_TEST_TIMEOUT_MS);

    it('answers an import and an import undo with 409 macrocycle-busy when page writes hold it past the wait, writing nothing', async () => {
      const date = '2025-05-05';
      const committed = await upload(commitImport, date);
      expect(committed.statusCode).toBe(200);
      const batchId: string = committed.json().batchId;
      const harness = await holdLock('shared');
      try {
        expectBusy(commitImport, await upload(commitImport, date));
        const undo = `${base}/import/${batchId}/undo`;
        expectBusy(undo, await injectAs(USER_LOCK, 'POST', undo));
        expect(await owner.macrocycle.count({ where: { userId: USER_LOCK, startDate: day(date) } })).toBe(1);
      } finally {
        harness.release();
        await harness.done;
      }
      expect((await injectAs(USER_LOCK, 'POST', `${base}/import/${batchId}/undo`)).statusCode).toBe(200);
      expect(await owner.macrocycle.count({ where: { userId: USER_LOCK, startDate: day(date) } })).toBe(0);
    }, LOCKED_TEST_TIMEOUT_MS);
  });

  /** Renumbering by start date (#1199), which every write runs since #1200. */
  describe('renumbering', () => {
    const base = `/programs/${PROGRAM}`;

    /** A live macrocycle `num` starting on `date`, with a row in every table that holds a number. */
    async function seedEveryTable(userId: string, num: number, date: string): Promise<void> {
      const at = { userId, program: PROGRAM, macrocycleNum: num };
      await owner.macrocycle.create({ data: { ...at, startDate: day(date), status: 'in-progress', origin: 'live' } });
      await owner.liftRecord.create({
        data: { ...at, workoutNum: 1, date: day(date), lift: 'Squat', setNum: 1, weight: 200, reps: 5 },
      });
      await owner.macrocycleDashboard.create({
        data: {
          ...at,
          macrocycleUnit: 'Week',
          macrocycleDate: day(date),
          sheetName: `${PROGRAM}_Cycle_${num}_${date.replace(/-/g, '')}`,
          macrocycleStartWeekday: 'Monday',
        },
      });
      await owner.macrocycleScheduledWorkout.create({ data: { ...at, workoutNum: 1, weekNum: 1, scheduledDate: day(date) } });
      await owner.workoutDateOverride.create({ data: { ...at, workoutNum: 1, newDate: day(date) } });
      await owner.workoutSkipOverride.create({ data: { ...at, workoutNum: 2 } });
      await owner.workoutLiftOverride.create({ data: { ...at, workoutNum: 1, lift: 'Dips', action: 'add' } });
      await owner.focusDayState.create({ data: { ...at, workoutNum: 1, state: {} } });
    }

    /** Each numbered table's distinct numbers for `userId`, read as the owner. */
    async function numbersByTable(userId: string): Promise<Record<string, number[]>> {
      const result: Record<string, number[]> = {};
      for (const table of NUMBERED_TABLES) {
        const rows = await owner.$queryRaw<Array<{ n: number }>>`
          SELECT DISTINCT "macrocycleNum" AS n FROM ${Prisma.raw(`"${table}"`)}
          WHERE "userId" = ${userId} AND "program" = ${PROGRAM} ORDER BY 1`;
        result[table] = rows.map((row) => row.n);
      }
      return result;
    }
    /** `nums` for every numbered table, with `overrides` for the tables named. */
    const everyTable = (nums: number[], overrides: Partial<Record<(typeof NUMBERED_TABLES)[number], number[]>> = {}) =>
      Object.fromEntries(NUMBERED_TABLES.map((table) => [table, overrides[table] ?? nums]));
    /** After an older import: the live macrocycle's rows on 2, and the import's set and macrocycle on 1. */
    const afterOlderImport = everyTable([2], { lift_record: [1, 2], macrocycle: [1, 2] });

    /** Commits a lift-records file of `rows` (after the header) as `userId`. */
    const commitFile = (userId: string, ...rows: string[]) => {
      const boundary = '----MacrocycleRenumberBoundary';
      return app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `${base}/import?mode=commit&destination=lift-records`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${userId}` },
        payload: [
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="upload.csv"',
          'Content-Type: text/csv',
          '',
          ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes', ...rows].join('\n'),
          `--${boundary}--`,
        ].join('\r\n'),
      });
    };
    const OLDER_SET = `${PROGRAM},9,1,2025-03-03,Bench Press,1,150,5,`;

    it('rewrites the number in every table as the app role, leaving another user alone', async () => {
      await seedEveryTable(USER_RENUMBER, 1, '2026-01-05');
      await seedEveryTable(USER_RENUMBER_OTHER, 1, '2026-01-05');

      // An older macrocycle arrives, so the live one becomes 2.
      expect((await commitFile(USER_RENUMBER, OLDER_SET)).statusCode).toBe(200);

      expect(await numbersByTable(USER_RENUMBER)).toEqual(afterOlderImport);
      expect(await numbersByTable(USER_RENUMBER_OTHER)).toEqual(everyTable([1]));
      const rows = await owner.macrocycle.findMany({ where: { userId: USER_RENUMBER }, orderBy: { macrocycleNum: 'asc' } });
      expect(rows.map((row) => [row.macrocycleNum, row.origin, isoDay(row.startDate)])).toEqual([
        [1, 'legacy', '2025-03-03'],
        [2, 'live', '2026-01-05'],
      ]);
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('refuses a rewrite before moving anything when a table holds a number it needs, naming the table', async () => {
      await seedEveryTable(USER_RENUMBER_ATOMIC, 1, '2026-01-05');
      // Only the macrocycle table, the last one rewritten, holds 2.
      await owner.macrocycle.create({
        data: { userId: USER_RENUMBER_ATOMIC, program: PROGRAM, macrocycleNum: 2, startDate: day('2026-03-02'), status: 'unknown', origin: 'legacy' },
      });
      const appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
      spans.reset();
      try {
        await expect(
          asUser(appDb, USER_RENUMBER_ATOMIC, (tx) =>
            new PrismaMacrocycleRepository(tx, USER_RENUMBER_ATOMIC).rewriteNumbers(PROGRAM, new Map([[1, 2]])),
          ),
        ).rejects.toMatchObject({
          constructor: MacrocycleNumberConflictError,
          detail: { table: 'macrocycle', heldNumber: 2 },
        });
      } finally {
        await appDb.$disconnect();
      }
      const rewrite = spans.getFinishedSpans().find((s) => s.name === 'macrocycle.rewrite_numbers');
      expect(rewrite?.attributes).toMatchObject({
        'macrocycle.conflict_table': 'macrocycle',
        'macrocycle.conflict_number': 2,
      });

      expect(await numbersByTable(USER_RENUMBER_ATOMIC)).toEqual(everyTable([1], { macrocycle: [1, 2] }));
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('lists every table with a macrocycle number', async () => {
      const columns = await owner.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'macrocycleNum' ORDER BY 1`;
      expect(columns.map((c) => c.table_name)).toEqual([...NUMBERED_TABLES].sort());
    });

    it('removes an emptied legacy macrocycle from every table on undo, so nothing it held joins the one that moves down', async () => {
      const user = USER_RENUMBER_ORPHAN;
      await seedEveryTable(user, 1, '2026-01-05');
      const commit = await commitFile(user, OLDER_SET);
      expect(commit.statusCode).toBe(200);
      // The import's legacy macrocycle is 1 now. The lifter skips one of its workouts, and
      // another batch has a key on it.
      await owner.workoutSkipOverride.create({ data: { userId: user, program: PROGRAM, macrocycleNum: 1, workoutNum: 7 } });
      const other = await owner.importBatch.create({
        data: {
          userId: user,
          program: PROGRAM,
          destination: 'lift-records',
          preImage: { '1:4:Squat:1': { kind: 'created', wrote: { weight: 1, reps: 1, notes: '' } } },
        },
      });

      const undo = await injectAs(user, 'POST', `${base}/import/${(commit.json() as { batchId: string }).batchId}/undo`);
      expect(undo.statusCode).toBe(200);

      // The live macrocycle moved down to 1, with only its own skip.
      expect(await numbersByTable(user)).toEqual(everyTable([1]));
      const skips = await owner.workoutSkipOverride.findMany({ where: { userId: user } });
      expect(skips.map((s) => [s.macrocycleNum, s.workoutNum])).toEqual([[1, 2]]);
      expect((await owner.importBatch.findUnique({ where: { id: other.id } }))?.preImage).toEqual({});
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('moves rows saved before initializing past an import, and back on undo, so neither takes them', async () => {
      const user = USER_RENUMBER_UNSTARTED;
      // The program has no macrocycle, so a page wrote these on the next number, 1.
      const at = { userId: user, program: PROGRAM, macrocycleNum: 1 };
      await owner.focusDayState.create({ data: { ...at, workoutNum: 1, state: {} } });
      await owner.workoutSkipOverride.create({ data: { ...at, workoutNum: 2 } });
      const unstartedOn = (n: number[]) => everyTable([], { focus_day_state: n, workout_skip_override: n });

      const commit = await commitFile(user, OLDER_SET);
      expect(commit.statusCode).toBe(200);
      expect(await numbersByTable(user)).toEqual({ ...unstartedOn([2]), macrocycle: [1], lift_record: [1] });

      const undo = await injectAs(user, 'POST', `${base}/import/${(commit.json() as { batchId: string }).batchId}/undo`);
      expect(undo.statusCode).toBe(200);
      expect(await numbersByTable(user)).toEqual(unstartedOn([1]));
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('drops batch keys on a deleted macrocycle, so undoing the batch leaves the history that moves onto its number', async () => {
      const user = USER_RENUMBER_STALE;
      await seedEveryTable(user, 1, '2026-01-05');
      await owner.macrocycle.create({
        data: { userId: user, program: PROGRAM, macrocycleNum: 2, startDate: day('2026-06-01'), status: 'completed', origin: 'imported' },
      });
      await owner.liftRecord.create({
        data: { userId: user, program: PROGRAM, macrocycleNum: 2, workoutNum: 1, date: day('2026-06-01'), lift: 'Squat', setNum: 1, weight: 999, reps: 5 },
      });
      // A batch from before the date joined the key (#884): it matches its set on any date.
      const stale = await owner.importBatch.create({
        data: {
          userId: user,
          program: PROGRAM,
          destination: 'lift-records',
          preImage: { '1:1:Squat:1': { kind: 'created', wrote: { weight: 200, reps: 5, notes: '' } } },
        },
      });

      // A focus state on a number with no macrocycle goes with the live and legacy ones.
      await owner.focusDayState.create({ data: { userId: user, program: PROGRAM, macrocycleNum: 3, workoutNum: 1, state: {} } });

      expect((await injectAs(user, 'DELETE', `${base}/macrocycles/current`)).statusCode).toBe(204);
      expect((await owner.macrocycle.findMany({ where: { userId: user } })).map((m) => [m.macrocycleNum, m.origin])).toEqual([
        [1, 'imported'],
      ]);
      expect(await numbersByTable(user)).toEqual(everyTable([], { macrocycle: [1], lift_record: [1] }));

      const undo = await injectAs(user, 'POST', `${base}/import/${stale.id}/undo`);
      expect(undo.json()).toMatchObject({ restored: 0 });
      const sets = await owner.liftRecord.findMany({ where: { userId: user } });
      expect(sets.map((s) => [s.macrocycleNum, s.weight])).toEqual([[1, 999]]);
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('undoes a batch with current keys and one with date-blind keys after a renumbering, each removing only its own sets', async () => {
      const user = USER_RENUMBER_BATCH;
      await seedEveryTable(user, 1, '2026-01-05');
      const set = (workoutNum: number, date: string, lift: string, setNum: number) => ({
        userId: user, program: PROGRAM, macrocycleNum: 1, workoutNum, date: day(date), lift, setNum, weight: 100, reps: 5,
      });
      await owner.liftRecord.createMany({
        data: [set(1, '2026-01-05', 'Squat', 2), set(2, '2026-01-07', 'Bench Press', 1), set(3, '2026-01-09', 'Deadlift', 1)],
      });
      const created = { kind: 'created', wrote: { weight: 100, reps: 5, notes: '' } };
      const current = await owner.importBatch.create({
        data: {
          userId: user,
          program: PROGRAM,
          destination: 'lift-records',
          preImage: {
            [liftRecordNaturalKey({ macrocycleNum: 1, workoutNum: 1, date: day('2026-01-05'), lift: 'Squat', setNum: 2 })]: created,
          },
        },
      });
      // A batch from before the date joined the key (#884).
      const dateBlind = await owner.importBatch.create({
        data: { userId: user, program: PROGRAM, destination: 'lift-records', preImage: { '1:2:Bench Press:1': created } },
      });

      expect((await commitFile(user, OLDER_SET)).statusCode).toBe(200);
      const sets = async () =>
        (await owner.liftRecord.findMany({ where: { userId: user }, orderBy: [{ date: 'asc' }, { setNum: 'asc' }] })).map(
          (r) => `${r.macrocycleNum} ${isoDay(r.date)} ${r.lift} ${r.setNum}`,
        );
      expect(await sets()).toEqual([
        '1 2025-03-03 bench-press 1',
        '2 2026-01-05 Squat 1',
        '2 2026-01-05 Squat 2',
        '2 2026-01-07 Bench Press 1',
        '2 2026-01-09 Deadlift 1',
      ]);

      const undoCurrent = await injectAs(user, 'POST', `${base}/import/${current.id}/undo`);
      expect(undoCurrent.json()).toMatchObject({ restored: 1, skipped: 0 });
      expect(await sets()).toEqual([
        '1 2025-03-03 bench-press 1',
        '2 2026-01-05 Squat 1',
        '2 2026-01-07 Bench Press 1',
        '2 2026-01-09 Deadlift 1',
      ]);

      const undoDateBlind = await injectAs(user, 'POST', `${base}/import/${dateBlind.id}/undo`);
      expect(undoDateBlind.json()).toMatchObject({ restored: 1, skipped: 0 });
      expect(await sets()).toEqual(['1 2025-03-03 bench-press 1', '2 2026-01-05 Squat 1', '2 2026-01-09 Deadlift 1']);
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('holds a rewrite back until a page write holding the lock across its id check has finished', async () => {
      const user = USER_RENUMBER_LOCK;
      await seedEveryTable(user, 1, '2026-01-05');
      // The harness stands in for a page write between its id check and its write.
      const harness = await holdOpen(owner, null, (tx) =>
        tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${user}, ${MACROCYCLE_LOCK_NAMESPACE}))::text`,
      );
      let released = false;
      try {
        const pending = commitFile(user, OLDER_SET);
        await waitForBlockedBy(harness.pid);
        expect(await numbersByTable(user)).toEqual(everyTable([1]));
        harness.release();
        released = true;
        expect((await pending).statusCode).toBe(200);
      } finally {
        if (!released) harness.release();
        await harness.done;
      }
      expect(await numbersByTable(user)).toEqual(afterOlderImport);
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('upgrades a delete holding the lock shared to exclusive once the page write holding it has finished', async () => {
      const user = USER_RENUMBER_UPGRADE;
      await seedEveryTable(user, 2, '2026-01-05');
      for (const [num, date] of [[1, '2025-01-06'], [3, '2026-03-02']] as const) {
        await owner.macrocycle.create({
          data: { userId: user, program: PROGRAM, macrocycleNum: num, startDate: day(date), status: 'completed', origin: 'imported' },
        });
      }
      const numbers = async () =>
        (await owner.macrocycle.findMany({ where: { userId: user }, orderBy: { macrocycleNum: 'asc' } })).map((row) => row.macrocycleNum);
      const harness = await holdOpen(owner, null, (tx) =>
        tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${user}, ${MACROCYCLE_LOCK_NAMESPACE}))::text`,
      );
      let released = false;
      try {
        // Deleting the live 2 moves imported 3 down, which needs the lock exclusively.
        const pending = injectAs(user, 'DELETE', `${base}/macrocycles/current`);
        await waitForBlockedBy(harness.pid);
        expect(await numbers()).toEqual([1, 2, 3]);
        harness.release();
        released = true;
        expect((await pending).statusCode).toBe(204);
      } finally {
        if (!released) harness.release();
        await harness.done;
      }
      expect(await numbers()).toEqual([1, 2]);
    }, DB_E2E_HOOK_TIMEOUT_MS);

    it('refuses one of two requests holding the lock shared that both ask for it exclusively, and lets the other through', async () => {
      const user = USER_RENUMBER_DEADLOCK;
      const appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
      let bothShared = () => undefined as void;
      const shared = new Promise<void>((resolve) => {
        let count = 0;
        bothShared = () => {
          if (++count === 2) resolve();
        };
      });
      // As two starts or deletes do: shared for the id check, then exclusive to renumber.
      const request = () =>
        asUser(appDb, user, async (tx) => {
          const repo = new PrismaMacrocycleRepository(tx, user);
          expect(await repo.tryLockShared()).toBe(true);
          bothShared();
          await shared;
          return repo.lockExclusive(IMPORT_LOCK_WAIT_MS);
        });
      try {
        // Postgres finds the deadlock after `deadlock_timeout` (1s), well inside the 5s wait.
        expect((await Promise.all([request(), request()])).sort()).toEqual([false, true]);
      } finally {
        await appDb.$disconnect();
      }
    }, DB_E2E_HOOK_TIMEOUT_MS);

    /**
     * The migration's renumbering of stored history (#1200). Each test runs the functions for
     * its own user and commits, since other suites share this database.
     */
    describe('numbering stored history by date (#1200)', () => {
      const renumberByDate = (user: string) => owner.$queryRaw`SELECT "macrocycle_renumber_by_date"(${user})`;
      const reverse = (user: string) => owner.$queryRaw`SELECT "macrocycle_renumber_reverse"(${user})`;
      const created = { kind: 'created', wrote: { weight: 100, reps: 5, notes: '' } };
      const set = (user: string, macrocycleNum: number, workoutNum: number, date: string, lift: string) => ({
        userId: user, program: PROGRAM, macrocycleNum, workoutNum, date: day(date), lift, setNum: 1, weight: 100, reps: 5,
      });
      const legacy = (user: string, macrocycleNum: number, date: string) => ({
        userId: user, program: PROGRAM, macrocycleNum, startDate: day(date), status: 'unknown', origin: 'legacy',
      });

      /**
       * History stored before renumbering, out of date order: legacy 1 starts in March, legacy 2
       * in January, and the live macrocycle is 3. A batch from before the backfill created
       * macrocycle 1 and its set.
       */
      async function seedOutOfOrder(user: string): Promise<string> {
        await seedEveryTable(user, 3, '2026-05-04');
        await owner.macrocycle.createMany({ data: [legacy(user, 1, '2026-03-02'), legacy(user, 2, '2026-01-05')] });
        await owner.liftRecord.createMany({
          data: [set(user, 1, 1, '2026-03-02', 'Bench Press'), set(user, 2, 1, '2026-01-05', 'Deadlift')],
        });
        const batch = await owner.importBatch.create({
          data: {
            userId: user,
            program: PROGRAM,
            destination: 'lift-records',
            createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
            preImage: {
              [liftRecordNaturalKey({ macrocycleNum: 1, workoutNum: 1, date: day('2026-03-02'), lift: 'Bench Press', setNum: 1 })]: created,
              ...legacyRowsPreImage([1]),
            },
          },
        });
        return batch.id;
      }

      const rowsOf = async (user: string) =>
        (await owner.macrocycle.findMany({ where: { userId: user }, orderBy: { macrocycleNum: 'asc' } })).map((row) => ({
          num: row.macrocycleNum,
          start: isoDay(row.startDate),
          origin: row.origin,
          backfillNumber: row.backfillNumber,
        }));
      const setsOf = async (user: string) =>
        (await owner.liftRecord.findMany({ where: { userId: user }, orderBy: [{ date: 'asc' }, { lift: 'asc' }] })).map(
          (r) => `${r.macrocycleNum} ${isoDay(r.date)} ${r.lift}`,
        );
      const preImageOf = async (id: string) => (await owner.importBatch.findUniqueOrThrow({ where: { id } })).preImage;

      it('numbers stored history by start date in every table and batch key, recording each old number', async () => {
        const user = USER_HISTORY_ORDER;
        const batchId = await seedOutOfOrder(user);

        await renumberByDate(user);

        expect(await rowsOf(user)).toEqual([
          { num: 1, start: '2026-01-05', origin: 'legacy', backfillNumber: 2 },
          { num: 2, start: '2026-03-02', origin: 'legacy', backfillNumber: 1 },
          { num: 3, start: '2026-05-04', origin: 'live', backfillNumber: 3 },
        ]);
        expect(await setsOf(user)).toEqual(['1 2026-01-05 Deadlift', '2 2026-03-02 Bench Press', '3 2026-05-04 Squat']);
        expect(await numbersByTable(user)).toEqual(everyTable([3], { lift_record: [1, 2, 3], macrocycle: [1, 2, 3] }));
        expect(await preImageOf(batchId)).toEqual({
          '2:1:20260302:Bench Press:1': created,
          'macrocycle-row:2': { kind: 'created', wrote: { macrocycleNum: 2 } },
        });
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('the reversal puts back every number and batch key the backfill changed', async () => {
        const user = USER_HISTORY_REVERSE;
        const batchId = await seedOutOfOrder(user);
        const before = { rows: await setsOf(user), tables: await numbersByTable(user), preImage: await preImageOf(batchId) };

        await renumberByDate(user);
        expect(await setsOf(user)).not.toEqual(before.rows);
        expect(await preImageOf(batchId)).not.toEqual(before.preImage);
        await reverse(user);

        expect({ rows: await setsOf(user), tables: await numbersByTable(user), preImage: await preImageOf(batchId) }).toEqual(before);
        expect((await rowsOf(user)).map((row) => [row.num, row.start])).toEqual([
          [1, '2026-03-02'],
          [2, '2026-01-05'],
          [3, '2026-05-04'],
        ]);
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('the reversal moves the keys of an import made after the backfill to the old numbers', async () => {
        const user = USER_HISTORY_LATER_IMPORT;
        await seedOutOfOrder(user);
        await renumberByDate(user);
        // The January Deadlift is on 1 now, and was on 2.
        const later = await owner.importBatch.create({
          data: {
            userId: user,
            program: PROGRAM,
            destination: 'lift-records',
            preImage: {
              [liftRecordNaturalKey({ macrocycleNum: 1, workoutNum: 1, date: day('2026-01-05'), lift: 'Deadlift', setNum: 1 })]: created,
            },
          },
        });

        await reverse(user);

        expect(await setsOf(user)).toEqual(['2 2026-01-05 Deadlift', '1 2026-03-02 Bench Press', '3 2026-05-04 Squat']);
        expect(await preImageOf(later.id)).toEqual({ '2:1:20260105:Deadlift:1': created });
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('moves negative stored numbers there and back, in rows and batch keys', async () => {
        // A file's number was stored as is before #1224 checked its range.
        const user = USER_HISTORY_NEGATIVE;
        await owner.macrocycle.createMany({ data: [legacy(user, 5, '2026-01-05'), legacy(user, -2, '2026-03-02'), legacy(user, -1, '2026-05-04')] });
        await owner.liftRecord.createMany({
          data: [set(user, 5, 1, '2026-01-05', 'Squat'), set(user, -2, 1, '2026-03-02', 'Bench Press'), set(user, -1, 1, '2026-05-04', 'Deadlift')],
        });
        const batch = await owner.importBatch.create({
          data: {
            userId: user,
            program: PROGRAM,
            destination: 'lift-records',
            preImage: {
              [liftRecordNaturalKey({ macrocycleNum: -2, workoutNum: 1, date: day('2026-03-02'), lift: 'Bench Press', setNum: 1 })]: created,
              ...legacyRowsPreImage([-2]),
            },
          },
        });
        const before = { sets: await setsOf(user), preImage: await preImageOf(batch.id) };

        await renumberByDate(user);

        expect(await setsOf(user)).toEqual(['1 2026-01-05 Squat', '2 2026-03-02 Bench Press', '3 2026-05-04 Deadlift']);
        expect(await preImageOf(batch.id)).toEqual({
          '2:1:20260302:Bench Press:1': created,
          'macrocycle-row:2': { kind: 'created', wrote: { macrocycleNum: 2 } },
        });

        await reverse(user);

        expect({ sets: await setsOf(user), preImage: await preImageOf(batch.id) }).toEqual(before);
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('moves rows saved ahead of the next macrocycle past the last one, there and back', async () => {
        const user = USER_HISTORY_UNSTARTED;
        await seedEveryTable(user, 3, '2026-05-04');
        await owner.macrocycle.create({ data: legacy(user, 1, '2026-01-05') });
        await owner.liftRecord.create({ data: set(user, 1, 1, '2026-01-05', 'Bench Press') });
        // A focus state saved for the macrocycle after 3, which has no row yet.
        await owner.focusDayState.create({ data: { userId: user, program: PROGRAM, macrocycleNum: 4, workoutNum: 1, state: {} } });
        const before = await numbersByTable(user);

        await renumberByDate(user);

        expect(await numbersByTable(user)).toEqual(everyTable([2], { lift_record: [1, 2], macrocycle: [1, 2], focus_day_state: [2, 3] }));

        await reverse(user);

        expect(await numbersByTable(user)).toEqual(before);
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('locks a user whose numbers are only in tables other than macrocycle', async () => {
        const user = USER_HISTORY_LOCK;
        await owner.focusDayState.create({ data: { userId: user, program: PROGRAM, macrocycleNum: 1, workoutNum: 1, state: {} } });
        const other = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
        try {
          await owner.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT "macrocycle_lock_every_user"(${user})`;
            const got = await other.$queryRaw<Array<{ got: boolean }>>`
              SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${user}, 1171)) AS got`;
            expect(got[0]?.got).toBe(false);
          });
        } finally {
          await other.$disconnect();
        }
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('the migration steps skip a lock another request holds, and a later call waits for it', async () => {
        const user = USER_HISTORY_NO_WAIT;
        await seedOutOfOrder(user);
        const other = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
        let release = () => undefined as void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let held = () => undefined as void;
        const holding = new Promise<void>((resolve) => (held = resolve));
        // A request that holds the user's lock shared, as a page write does before reading "macrocycle".
        const holder = other.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${user}, 1171))`;
            held();
            await released;
          },
          { timeout: DB_E2E_HOOK_TIMEOUT_MS },
        );
        const withTimeout = (wait: boolean) =>
          owner.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
            return tx.$queryRaw`SELECT "macrocycle_renumber_by_date"(${user}, ${wait}) AS moved`;
          });
        try {
          await holding;
          await expect(withTimeout(true)).rejects.toThrow(/lock timeout/);
          await withTimeout(false);
        } finally {
          release();
          await holder;
          await other.$disconnect();
        }
        expect((await owner.macrocycle.findMany({ where: { userId: user }, orderBy: { startDate: 'asc' } })).map((m) => m.macrocycleNum)).toEqual([1, 2, 3]);
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('the reversal refuses, moving nothing, when a macrocycle has no recorded number', async () => {
        const user = USER_HISTORY_NEW_ROW;
        await seedOutOfOrder(user);
        await renumberByDate(user);
        const after = await setsOf(user);
        // A macrocycle the new revision created after the backfill.
        await owner.macrocycle.create({ data: legacy(user, 4, '2026-07-06') });

        await expect(reverse(user)).rejects.toThrow(/Macrocycle 4 of program 5-3-1 .* has no backfillNumber/);
        expect(await setsOf(user)).toEqual(after);
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('undoing a batch from before the backfill removes its macrocycle and leaves none without sets but the live one', async () => {
        const user = USER_HISTORY_UNDO;
        const batchId = await seedOutOfOrder(user);
        await renumberByDate(user);

        const res = await injectAs(user, 'POST', `${base}/import/${batchId}/undo`);

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ restored: 1, skipped: 0 });
        expect(await rowsOf(user)).toEqual([
          { num: 1, start: '2026-01-05', origin: 'legacy', backfillNumber: 2 },
          { num: 2, start: '2026-05-04', origin: 'live', backfillNumber: 3 },
        ]);
        const empty = await owner.$queryRaw<Array<{ n: number; origin: string }>>`
          SELECT m."macrocycleNum" AS n, m."origin" FROM "macrocycle" AS m
          WHERE m."userId" = ${user} AND NOT EXISTS (
            SELECT 1 FROM "lift_record" AS r
            WHERE r."userId" = m."userId" AND r."program" = m."program" AND r."macrocycleNum" = m."macrocycleNum")`;
        expect(empty.filter((row) => row.origin !== 'live')).toEqual([]);
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('closes a live row the old revision left open, by the closing rule, and leaves the current one open', async () => {
        const user = USER_HISTORY_WINDOW;
        // The current macrocycle, on the dashboard.
        await seedEveryTable(user, 2, '2026-03-02');
        const open = (program: string, extra: Partial<{ statusChosen: boolean }> = {}) => ({
          userId: user, program, macrocycleNum: 1, startDate: day('2026-01-05'), status: 'in-progress', origin: 'live', ...extra,
        });
        const schedule = (program: string, workouts: number, first = 1) =>
          Array.from({ length: workouts }, (_, i) => ({
            userId: user, program, macrocycleNum: 1, workoutNum: first + i, weekNum: 1, scheduledDate: day('2026-01-05'),
          }));
        const logged = (program: string, workoutNum: number, date: string) => ({ ...set(user, 1, workoutNum, date, 'Squat'), program });
        await owner.macrocycle.createMany({
          data: [
            open(PROGRAM),
            open('window-abandoned'),
            open('window-unknown'),
            open('window-chosen', { statusChosen: true }),
            open('window-from-3'),
          ],
        });
        await owner.macrocycleScheduledWorkout.createMany({
          data: [...schedule(PROGRAM, 2), ...schedule('window-abandoned', 3), ...schedule('window-chosen', 1), ...schedule('window-from-3', 2, 3)],
        });
        await owner.liftRecord.createMany({
          data: [
            logged(PROGRAM, 1, '2026-01-05'),
            logged(PROGRAM, 2, '2026-01-12'),
            logged('window-abandoned', 1, '2026-01-07'),
            // Its schedule is workouts 3 and 4, both logged.
            logged('window-from-3', 3, '2026-01-08'),
            logged('window-from-3', 4, '2026-01-09'),
          ],
        });

        const closed = await owner.$queryRaw<Array<{ closed: number }>>`SELECT "macrocycle_close_window_rows"(${user}) AS closed`;

        expect(closed[0]?.closed).toBe(5);
        const rows = await owner.macrocycle.findMany({ where: { userId: user }, orderBy: [{ program: 'asc' }, { macrocycleNum: 'asc' }] });
        // The last column: whether the row records that the migration closed it.
        expect(rows.map((row) => [row.program, row.macrocycleNum, row.status, isoDay(row.endDate), row.backfillClosedAt !== null])).toEqual([
          [PROGRAM, 1, 'completed', '2026-01-12', true],
          [PROGRAM, 2, 'in-progress', null, false],
          ['window-abandoned', 1, 'abandoned', '2026-01-07', true],
          ['window-chosen', 1, 'in-progress', '2026-01-05', true],
          ['window-from-3', 1, 'completed', '2026-01-09', true],
          ['window-unknown', 1, 'unknown', '2026-01-05', true],
        ]);
      }, DB_E2E_HOOK_TIMEOUT_MS);

      it('the app role cannot run any of them', async () => {
        const appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
        try {
          for (const fn of [
            'macrocycle_lock_every_user',
            'macrocycle_unstarted_numbers',
            'macrocycle_close_window_rows',
            'macrocycle_renumber_by_date',
            'macrocycle_renumber_reverse',
          ]) {
            await expect(
              asUser(appDb, USER_HISTORY_ORDER, (tx) => tx.$queryRawUnsafe(`SELECT "${fn}"($1)`, USER_HISTORY_ORDER)),
            ).rejects.toThrow(/permission denied/);
          }
          await expect(
            asUser(appDb, USER_HISTORY_ORDER, (tx) => tx.$queryRaw`SELECT "macrocycle_backfill_window_rows"()`),
          ).rejects.toThrow(/permission denied/);
          await expect(
            asUser(appDb, USER_HISTORY_ORDER, (tx) =>
              tx.$queryRaw`SELECT "macrocycle_rewrite_numbers"(ARRAY['x'], ARRAY['p'], ARRAY[1], ARRAY[2])`,
            ),
          ).rejects.toThrow(/permission denied/);
        } finally {
          await appDb.$disconnect();
        }
      }, DB_E2E_HOOK_TIMEOUT_MS);
    });
  });
});
