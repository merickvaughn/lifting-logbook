// Real-Postgres E2E suite. Postgres is provisioned by jest.global-setup.js:
//   - Local: an ephemeral container via @testcontainers/postgresql (Docker required).
//   - CI:    passthrough of the DATABASE_URL already exported by the
//            db-integration job's postgres service container.
// globalSetup provisions the `lifting_app` role's login password and exposes two
// connection strings (issue #646): LIFTING_TC_DATABASE_URL (the restricted lifting_app
// role) and LIFTING_TC_OWNER_DATABASE_URL (the superuser/owner opt-in). This spec uses
// both, deliberately for different things:
//   - `app` (the NestJS instance under test) restores DATABASE_URL from
//     LIFTING_TC_DATABASE_URL before boot, so every one of this file's HTTP-driven
//     assertions genuinely exercises the restricted role end to end — real RLS
//     enforcement on the same path production traffic takes.
//   - `prisma` (this file's own seeding/cleanup/DB-assertion client) connects via
//     LIFTING_TC_OWNER_DATABASE_URL explicitly, because this suite acts as a harness
//     across many synthetic users (Alice, Bob, TEST_USER, ...) rather than as one
//     authenticated request — exactly the legitimate owner-opt-in case.
// (jest.env.setup.js force-blanks DATABASE_URL in every worker so the in-memory e2e
// suite keeps wiring InMemoryRepositoryFactory; its Proxy allows restoring DATABASE_URL
// from either of the two sentinels above.)
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../app.module';
import {
  SEED_PROGRAM,
  seedCycleDashboard,
  seedLiftRecords,
  seedTrainingMaxes,
} from '../adapters/in-memory/fixtures';
import { DomainNotFoundFilter } from './not-found.filter';
import { DomainConflictFilter } from './conflict.filter';

// The main beforeAll below connects Prisma, seeds many tables, AND bootstraps a
// full Nest app. In isolation that finishes well under Jest's 5s default hook
// timeout, but under a full-suite Windows `turbo run test` it contends with the
// CSV-fixture-heavy web/core suites and intermittently trips the deadline (an
// isolation-only flake — apps/api/jest.config.js does not extend the win32-capped
// base config). 30s gives ample headroom while still failing fast on a genuine
// hang (Testcontainers readiness is already bounded in jest.global-setup.js). See #567.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const TEST_USER = 'db-e2e-primary';
const USER_ALICE = 'db-e2e-alice';
const USER_BOB = 'db-e2e-bob';

const USER_INIT = 'db-e2e-init';
const USER_HIST = 'db-e2e-hist';
const USER_SETT = 'db-e2e-settings';
const USER_SETT_OTHER = 'db-e2e-settings-other';
const USER_CUST = 'db-e2e-custom';
const USER_CUST_OTHER = 'db-e2e-custom-other';
const USER_CLIFT = 'db-e2e-custom-lift';
const USER_CLIFT_OTHER = 'db-e2e-custom-lift-other';
const USER_BW   = 'db-e2e-body-weight';
const USER_SW   = 'db-e2e-switch';

async function cleanTestUsers(prisma: PrismaClient): Promise<void> {
  const users = [TEST_USER, USER_ALICE, USER_BOB, USER_INIT, USER_HIST, USER_SETT, USER_SETT_OTHER, USER_CUST, USER_CUST_OTHER, USER_CLIFT, USER_CLIFT_OTHER, USER_BW, USER_SW];
  await prisma.liftRecord.deleteMany({ where: { userId: { in: users } } });
  await prisma.trainingMax.deleteMany({ where: { userId: { in: users } } });
  await prisma.trainingMaxHistory.deleteMany({ where: { userId: { in: users } } });
  await prisma.cycleDashboard.deleteMany({ where: { userId: { in: users } } });
  await prisma.workoutLiftOverride.deleteMany({ where: { userId: { in: users } } });
  await prisma.workoutDateOverride.deleteMany({ where: { userId: { in: users } } });
  await prisma.strengthGoal.deleteMany({ where: { userId: { in: users } } });
  await prisma.liftMetadata.deleteMany({ where: { userId: { in: users } } });
  await prisma.userSettings.deleteMany({ where: { userId: { in: users } } });
  await prisma.customProgram.deleteMany({ where: { userId: { in: users } } });
  await prisma.customLift.deleteMany({ where: { userId: { in: users } } });
}

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
// Skip only when globalSetup did not provision a DB (e.g. Docker unavailable
// and not running in CI). Normal local / CI runs always have both sentinels set.
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

describeOrSkip('Programs HTTP (e2e, PrismaRepositoryFactory)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  beforeAll(() => {
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
  });

  const AUTH = { authorization: `Bearer ${TEST_USER}` };

  const get = (url: string) =>
    app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers: AUTH });

  const post = (url: string) =>
    app.getHttpAdapter().getInstance().inject({ method: 'POST', url, headers: AUTH });

  const postJson = (url: string, body: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...AUTH },
      payload: JSON.stringify(body),
    });

  const patchJson = (url: string, body: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'PATCH',
      url,
      headers: { 'content-type': 'application/json', ...AUTH },
      payload: JSON.stringify(body),
    });

  const putJson = (url: string, body: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url,
      headers: { 'content-type': 'application/json', ...AUTH },
      payload: JSON.stringify(body),
    });

  const deleteReq = (url: string) =>
    app.getHttpAdapter().getInstance().inject({ method: 'DELETE', url, headers: AUTH });

  const postCsv = (url: string, csvContent: string) => {
    const boundary = '----LiftRecordImportBoundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="records.csv"',
      'Content-Type: text/csv',
      '',
      csvContent,
      `--${boundary}--`,
    ].join('\r\n');
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...AUTH },
      payload: body,
    });
  };

  beforeAll(async () => {
    // Owner/superuser connection, explicit and deliberate (issue #646): this suite seeds
    // and asserts against many synthetic users as a test harness, not as one authenticated
    // request, so it bypasses RLS on purpose. `app` below boots against the ambient
    // DATABASE_URL (the restricted lifting_app role) — that's the connection every one of
    // this file's HTTP-driven `it()` blocks actually exercises.
    prisma = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });

    // Clean any leftover data from an interrupted previous run before seeding.
    await cleanTestUsers(prisma);

    const dashboard = seedCycleDashboard();
    // Seed CycleDashboard for TEST_USER plus the isolation-test users (Alice, Bob)
    // so the user-isolation specs can call /cycles/current and reschedule endpoints
    // without tripping the dashboard-precondition 404 in their handlers.
    await prisma.cycleDashboard.createMany({
      data: [TEST_USER, USER_ALICE, USER_BOB].map((userId) => ({
        userId,
        program: SEED_PROGRAM,
        cycleUnit: dashboard.cycleUnit,
        cycleNum: dashboard.cycleNum,
        cycleDate: dashboard.cycleDate,
        sheetName: dashboard.sheetName,
        cycleStartWeekday: dashboard.cycleStartWeekday,
        programType: dashboard.programType ?? null,
      })),
    });

    await prisma.trainingMax.createMany({
      data: seedTrainingMaxes().map((m) => ({
        userId: TEST_USER,
        program: SEED_PROGRAM,
        lift: m.lift,
        weight: m.weight,
        dateUpdated: m.dateUpdated,
      })),
    });

    await prisma.liftRecord.createMany({
      data: seedLiftRecords().map((r) => ({
        userId: TEST_USER,
        program: r.program,
        cycleNum: r.cycleNum,
        workoutNum: r.workoutNum,
        date: r.date,
        lift: r.lift,
        setNum: r.setNum,
        weight: r.weight,
        reps: r.reps,
        notes: r.notes,
      })),
    });

    // Seed one TrainingMaxHistory row so the order-sensitive write block has
    // pre-existing history to PATCH (mark-as-PR) and GET (?isPR=true) against.
    // The recalculate/cycle-advance tests do not produce history rows on their
    // own — the cycle-1 records yield reductions for current maxes, which are
    // flagged rather than applied (and so generate no history entries).
    await prisma.trainingMaxHistory.create({
      data: {
        userId: TEST_USER,
        program: SEED_PROGRAM,
        lift: 'Squat',
        weight: 315,
        date: new Date('2026-04-13'),
        isPR: false,
        source: 'program',
        goalMet: false,
      },
    });

    // DATABASE_URL is set in the environment, so RepositoryFactoryModule selects PrismaRepositoryFactory.
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(multipart as any, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await cleanTestUsers(prisma);
    await prisma?.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('GET /health returns ok without auth', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /programs/:program/cycles/current returns 401 without auth', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: `/programs/${SEED_PROGRAM}/cycles/current` });
    expect(res.statusCode).toBe(401);
  });

  it('GET /programs/:program/cycles/current returns the seeded cycle', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.program).toBe(SEED_PROGRAM);
    expect(body.cycleNum).toBe(1);
    expect(body.cycleStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('GET /programs/:program/workouts/:workoutNum returns grouped lifts', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/workouts/1`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workoutNum).toBe(1);
    expect(body.lifts.length).toBeGreaterThan(0);
  });

  it('GET /programs/:program/training-maxes returns the seeded maxes', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/training-maxes`);
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('GET /programs/:program/lift-records returns records for current cycle', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/lift-records`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.every((r: { cycleNum: number }) => r.cycleNum === 1)).toBe(true);
  });

  it('GET /programs/:program/spec returns the seeded program spec', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/spec`);
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('GET unknown program returns 404', async () => {
    const res = await get('/programs/does-not-exist/cycles/current');
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Write endpoints — order-sensitive; each test mutates DB state for TEST_USER
  // and the next test observes that state. Do not reorder or randomize.
  // -------------------------------------------------------------------------

  describe('write operations', () => {
    it('PATCH /programs/:program/training-maxes updates maxes and returns the full set', async () => {
      const res = await patchJson(`/programs/${SEED_PROGRAM}/training-maxes`, {
        maxes: [{ lift: 'Squat', weight: 300 }],
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      const squat = body.find((m: { lift: string }) => m.lift === 'Squat');
      expect(squat).toMatchObject({
        lift: 'Squat',
        weight: 300,
        unit: 'lbs',
        dateUpdated: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      });
    });

    it('POST /programs/:program/training-maxes/recalculate flags reductions without applying them', async () => {
      // Pre-condition: PATCH above set Squat to 300. The seeded cycle-1 records would
      // propose a Squat max of 210 (a *reduction*); updateMaxes flags reductions
      // and does not apply them, so the returned Squat weight stays at 300 and the
      // proposal appears in `flagged`. Response shape is { maxes, flagged }.
      const beforeRes = await get(`/programs/${SEED_PROGRAM}/training-maxes`);
      const squatBefore = beforeRes
        .json()
        .find((m: { lift: string }) => m.lift === 'Squat').weight;

      const res = await post(`/programs/${SEED_PROGRAM}/training-maxes/recalculate`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        maxes: Array<{ lift: string; weight: number; unit: string; dateUpdated: string }>;
        flagged: Array<{ lift: string; proposedWeight: number }>;
      };
      expect(Array.isArray(body.maxes)).toBe(true);
      expect(body.maxes.length).toBeGreaterThan(0);
      for (const m of body.maxes) {
        expect(m).toMatchObject({
          lift: expect.any(String),
          weight: expect.any(Number),
          unit: 'lbs',
          dateUpdated: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        });
      }
      const squatAfter = body.maxes.find((m) => m.lift === 'Squat')!.weight;
      // The core invariant: the recalculated Squat is unchanged because the
      // proposal was a reduction (flagged, not applied). flagged shape varies
      // by service version; asserting on its contents is over-specification.
      expect(squatAfter).toBe(squatBefore);
      expect(Array.isArray(body.flagged)).toBe(true);
    });

    it('POST /programs/:program/cycles advances cycleNum and persists new maxes', async () => {
      expect((await get(`/programs/${SEED_PROGRAM}/cycles/current`)).json().cycleNum).toBe(1);

      const res = await post(`/programs/${SEED_PROGRAM}/cycles`);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.program).toBe(SEED_PROGRAM);
      expect(body.cycleNum).toBe(2);
      expect(body.cycleStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const getRes = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().cycleNum).toBe(2);
    });

    it('POST /programs/:program/cycles with fromCycleNum uses that cycle\'s records', async () => {
      expect((await get(`/programs/${SEED_PROGRAM}/cycles/current`)).json().cycleNum).toBe(2);
      const res = await postJson(`/programs/${SEED_PROGRAM}/cycles`, { fromCycleNum: 1 });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.cycleNum).toBe(2);
      expect(body.cycleStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Verify the re-pinned cycle is persisted to the DB (not just returned in the response).
      const getRes = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().cycleNum).toBe(2);
    });

    it('POST /programs/:program/cycles with cycleDate pins the new cycle\'s start date', async () => {
      expect((await get(`/programs/${SEED_PROGRAM}/cycles/current`)).json().cycleNum).toBe(2);
      const res = await postJson(`/programs/${SEED_PROGRAM}/cycles`, {
        cycleDate: '2026-06-01',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().cycleStartDate).toBe('2026-06-01');
    });

    it('POST /programs/:program/cycles with fromCycleNum having no records returns 400', async () => {
      const res = await postJson(`/programs/${SEED_PROGRAM}/cycles`, { fromCycleNum: 99 });
      expect(res.statusCode).toBe(400);
    });

    it('POST /programs/unknown/cycles returns 404', async () => {
      const res = await post('/programs/does-not-exist/cycles');
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Training max history — order-sensitive, continues from write operations.
  // At this point cycle advances have written history rows for changed lifts.
  // -------------------------------------------------------------------------

  describe('training max history', () => {
    it('GET /training-maxes/history returns entries after cycle advances', async () => {
      const res = await get(`/programs/${SEED_PROGRAM}/training-maxes/history`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.entries)).toBe(true);
      for (const e of body.entries) {
        expect(e).toMatchObject({
          id: expect.any(String),
          lift: expect.any(String),
          weight: expect.any(Number),
          unit: 'lbs',
          date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          isPR: expect.any(Boolean),
          source: expect.stringMatching(/^(test|program)$/),
          goalMet: expect.any(Boolean),
        });
      }
    });

    it('GET /training-maxes/history?lift=Squat filters to that lift', async () => {
      const res = await get(`/programs/${SEED_PROGRAM}/training-maxes/history?lift=Squat`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries.every((e: { lift: string }) => e.lift === 'Squat')).toBe(true);
    });

    it('PATCH /training-maxes/history/:id marks entry as PR and persists to DB', async () => {
      const listRes = await get(`/programs/${SEED_PROGRAM}/training-maxes/history`);
      const entries = listRes.json().entries as Array<{ id: string }>;
      if (entries.length === 0) {
        // No maxes changed — skip toggle test gracefully
        return;
      }
      const firstId = entries[0].id;

      const patchRes = await patchJson(
        `/programs/${SEED_PROGRAM}/training-maxes/history/${firstId}`,
        { isPR: true },
      );
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({ id: firstId, isPR: true });

      // DB-level assertion
      const row = await prisma.trainingMaxHistory.findFirst({
        where: { id: firstId, userId: TEST_USER },
      });
      expect(row?.isPR).toBe(true);
    });

    it('GET /training-maxes/history?isPR=true returns only PR-marked entries', async () => {
      // Depends on the PATCH test above having marked the first entry.
      const res = await get(`/programs/${SEED_PROGRAM}/training-maxes/history?isPR=true`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries.length).toBeGreaterThan(0);
      expect(body.entries.every((e: { isPR: boolean }) => e.isPR === true)).toBe(true);
    });

    it('PATCH /training-maxes/history/:id with unknown id returns 404', async () => {
      const res = await patchJson(
        `/programs/${SEED_PROGRAM}/training-maxes/history/nonexistent-id`,
        { isPR: true },
      );
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST cycles/initialize — uses USER_INIT who has no seed data.
  // Order-sensitive within the block (409 test depends on happy path row).
  // -------------------------------------------------------------------------

  describe('POST /programs/:program/cycles/initialize (DB)', () => {
    const AS_INIT = { authorization: `Bearer ${USER_INIT}` };

    it('happy path — creates a CycleDashboard row and returns 201 with expected shape', async () => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/programs/5-3-1/cycles/initialize',
        headers: { 'content-type': 'application/json', ...AS_INIT },
        payload: JSON.stringify({ cycleDate: '2026-06-02' }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.program).toBe('5-3-1');
      expect(body.cycleNum).toBe(1);
      expect(body.cycleStartDate).toBe('2026-06-02');
      expect(body.currentWeekType).toBe('training');
      expect(body.weeks).toEqual([]);

      // DB-level assertion
      const row = await prisma.cycleDashboard.findFirst({
        where: { userId: USER_INIT, program: '5-3-1' },
      });
      expect(row).not.toBeNull();
      expect(row?.cycleNum).toBe(1);
    });

    it('409 Conflict — second call for the same user+program', async () => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/programs/5-3-1/cycles/initialize',
        headers: { 'content-type': 'application/json', ...AS_INIT },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(409);
    });

    it('400 Bad Request — unrecognized program ID', async () => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/programs/not-a-real-program/cycles/initialize',
        headers: { 'content-type': 'application/json', ...AS_INIT },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('isolates row-level data between users in Postgres', async () => {
    const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
      app.getHttpAdapter().getInstance(),
    );

    const AS_ALICE = { authorization: `Bearer ${USER_ALICE}` };
    const AS_BOB = { authorization: `Bearer ${USER_BOB}` };

    // Alice writes a distinctive training max — her rows start empty, this creates it.
    const patchRes = await injectRaw({
      method: 'PATCH',
      url: `/programs/${SEED_PROGRAM}/training-maxes`,
      headers: { 'content-type': 'application/json', ...AS_ALICE },
      payload: JSON.stringify({ maxes: [{ lift: 'Squat', weight: 999 }] }),
    });
    expect(patchRes.statusCode).toBe(200);

    // Alice sees her value.
    const aliceRes = await injectRaw({
      method: 'GET',
      url: `/programs/${SEED_PROGRAM}/training-maxes`,
      headers: AS_ALICE,
    });
    expect(aliceRes.json().find((m: { lift: string }) => m.lift === 'Squat')?.weight).toBe(999);

    // Bob reads the same program — his rows are independent; Alice's write must not appear.
    const bobRes = await injectRaw({
      method: 'GET',
      url: `/programs/${SEED_PROGRAM}/training-maxes`,
      headers: AS_BOB,
    });
    expect(bobRes.statusCode).toBe(200);
    const bobSquat = bobRes.json().find((m: { lift: string }) => m.lift === 'Squat');
    expect(bobSquat).toBeUndefined();

    // Verify at the DB layer — Alice's row exists and Bob's does not.
    const aliceRow = await prisma.trainingMax.findFirst({
      where: { userId: USER_ALICE, program: SEED_PROGRAM, lift: 'Squat' },
    });
    expect(aliceRow?.weight).toBe(999);

    const bobRow = await prisma.trainingMax.findFirst({
      where: { userId: USER_BOB, program: SEED_PROGRAM, lift: 'Squat' },
    });
    expect(bobRow).toBeNull();
  });

  describe('workout lift overrides (DB)', () => {
    const deleteReq = (url: string) =>
      app.getHttpAdapter().getInstance().inject({ method: 'DELETE', url, headers: AUTH });

    it('POST override persists to the database', async () => {
      const dashRes = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
      const { cycleNum } = dashRes.json() as { cycleNum: number };

      const res = await postJson(
        `/programs/${SEED_PROGRAM}/cycles/${cycleNum}/workouts/1/lift-overrides`,
        { action: 'add', lift: 'Dips' },
      );
      expect(res.statusCode).toBe(201);

      const row = await prisma.workoutLiftOverride.findFirst({
        where: { userId: TEST_USER, program: SEED_PROGRAM, cycleNum, workoutNum: 1, lift: 'Dips' },
      });
      expect(row).not.toBeNull();
      expect(row?.action).toBe('add');
    });

    it('DELETE override removes the row', async () => {
      const dashRes = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
      const { cycleNum } = dashRes.json() as { cycleNum: number };

      // Create first
      await postJson(
        `/programs/${SEED_PROGRAM}/cycles/${cycleNum}/workouts/1/lift-overrides`,
        { action: 'remove', lift: 'Squat' },
      );

      // Then delete
      const delRes = await deleteReq(
        `/programs/${SEED_PROGRAM}/cycles/${cycleNum}/workouts/1/lift-overrides/Squat`,
      );
      expect(delRes.statusCode).toBe(204);

      const row = await prisma.workoutLiftOverride.findFirst({
        where: { userId: TEST_USER, program: SEED_PROGRAM, cycleNum, workoutNum: 1, lift: 'Squat' },
      });
      expect(row).toBeNull();
    });

    it('user isolation — lift overrides are scoped to userId', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
        app.getHttpAdapter().getInstance(),
      );
      const AS_ALICE = { authorization: `Bearer ${USER_ALICE}` };
      const AS_BOB = { authorization: `Bearer ${USER_BOB}` };

      const dashAlice = await injectRaw({ method: 'GET', url: `/programs/${SEED_PROGRAM}/cycles/current`, headers: AS_ALICE });
      const { cycleNum } = dashAlice.json() as { cycleNum: number };

      // Alice adds an override
      const alicePost = await injectRaw({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/${cycleNum}/workouts/1/lift-overrides`,
        headers: { 'content-type': 'application/json', ...AS_ALICE },
        payload: JSON.stringify({ action: 'add', lift: 'Face Pulls' }),
      });
      expect(alicePost.statusCode).toBe(201);

      // Bob GETs the workout — should NOT contain Face Pulls
      const bobWorkout = await injectRaw({ method: 'GET', url: `/programs/${SEED_PROGRAM}/workouts/1`, headers: AS_BOB });
      const bobLifts = (bobWorkout.json() as { lifts: { lift: string }[] }).lifts;
      expect(bobLifts.some((l) => l.lift === 'Face Pulls')).toBe(false);

      // DB layer — Alice's row exists, Bob's does not
      const aliceRow = await prisma.workoutLiftOverride.findFirst({
        where: { userId: USER_ALICE, program: SEED_PROGRAM, lift: 'Face Pulls' },
      });
      expect(aliceRow).not.toBeNull();

      const bobRow = await prisma.workoutLiftOverride.findFirst({
        where: { userId: USER_BOB, program: SEED_PROGRAM, lift: 'Face Pulls' },
      });
      expect(bobRow).toBeNull();
    });
  });

  describe('workout rescheduling (DB)', () => {
    it('PATCH reschedule persists override and GET workout returns overrideDate', async () => {
      const dashRes = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
      const { cycleNum } = dashRes.json() as { cycleNum: number };

      const patchRes = await patchJson(
        `/programs/${SEED_PROGRAM}/cycles/${cycleNum}/workouts/1/reschedule`,
        { newDate: '2026-09-01' },
      );
      expect(patchRes.statusCode).toBe(204);

      const workoutRes = await get(`/programs/${SEED_PROGRAM}/workouts/1`);
      expect(workoutRes.statusCode).toBe(200);
      expect(workoutRes.json().overrideDate).toBe('2026-09-01');

      const row = await prisma.workoutDateOverride.findFirst({
        where: { userId: TEST_USER, program: SEED_PROGRAM, cycleNum, workoutNum: 1 },
      });
      expect(row).not.toBeNull();
    });

    it('user isolation — reschedule override is scoped to userId', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
        app.getHttpAdapter().getInstance(),
      );
      const AS_ALICE = { authorization: `Bearer ${USER_ALICE}` };
      const AS_BOB = { authorization: `Bearer ${USER_BOB}` };

      // Alice reschedules cycle 1, workout 2
      const alicePatch = await injectRaw({
        method: 'PATCH',
        url: `/programs/${SEED_PROGRAM}/cycles/1/workouts/2/reschedule`,
        headers: { 'content-type': 'application/json', ...AS_ALICE },
        payload: JSON.stringify({ newDate: '2026-09-15' }),
      });
      expect(alicePatch.statusCode).toBe(204);

      // Bob GETs workout 2 — overrideDate must be absent
      const bobWorkout = await injectRaw({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/workouts/2`,
        headers: AS_BOB,
      });
      expect(bobWorkout.statusCode).toBe(200);
      expect(bobWorkout.json().overrideDate).toBeUndefined();

      // DB layer — Alice's row exists, Bob's does not
      const aliceRow = await prisma.workoutDateOverride.findFirst({
        where: { userId: USER_ALICE, program: SEED_PROGRAM, cycleNum: 1, workoutNum: 2 },
      });
      expect(aliceRow).not.toBeNull();

      const bobRow = await prisma.workoutDateOverride.findFirst({
        where: { userId: USER_BOB, program: SEED_PROGRAM, cycleNum: 1, workoutNum: 2 },
      });
      expect(bobRow).toBeNull();
    });
  });

  describe('strength goals (DB)', () => {
    const GOAL_URL = `/programs/${SEED_PROGRAM}/strength-goals`;

    it('PUT → GET → DELETE lifecycle persists to and removes from the database', async () => {
      const putRes = await putJson(`${GOAL_URL}/Squat`, { goalType: 'absolute', target: 405, unit: 'lbs' });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json()).toMatchObject({ lift: 'Squat', goalType: 'absolute', target: 405 });

      const getRes = await get(GOAL_URL);
      expect(getRes.statusCode).toBe(200);
      const goals = getRes.json() as { lift: string; target: number }[];
      expect(goals.some((g) => g.lift === 'Squat' && g.target === 405)).toBe(true);

      const delRes = await deleteReq(`${GOAL_URL}/Squat`);
      expect(delRes.statusCode).toBe(204);

      const row = await prisma.strengthGoal.findFirst({
        where: { userId: TEST_USER, program: SEED_PROGRAM, lift: 'Squat' },
      });
      expect(row).toBeNull();
    });

    it('PUT same lift twice — upsert; only one DB row and latest target wins', async () => {
      await putJson(`${GOAL_URL}/Deadlift`, { goalType: 'absolute', target: 500, unit: 'lbs' });
      const secondPut = await putJson(`${GOAL_URL}/Deadlift`, { goalType: 'absolute', target: 550, unit: 'lbs' });
      expect(secondPut.statusCode).toBe(200);
      expect(secondPut.json().target).toBe(550);

      const rows = await prisma.strengthGoal.findMany({
        where: { userId: TEST_USER, program: SEED_PROGRAM, lift: 'Deadlift' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].target).toBe(550);
    });

    it('user isolation — strength goals are scoped to userId', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
        app.getHttpAdapter().getInstance(),
      );
      const AS_ALICE = { authorization: `Bearer ${USER_ALICE}` };
      const AS_BOB = { authorization: `Bearer ${USER_BOB}` };

      // Alice sets a goal
      const alicePut = await injectRaw({
        method: 'PUT',
        url: `${GOAL_URL}/Bench Press`,
        headers: { 'content-type': 'application/json', ...AS_ALICE },
        payload: JSON.stringify({ goalType: 'absolute', target: 225, unit: 'lbs' }),
      });
      expect(alicePut.statusCode).toBe(200);

      // Bob lists goals — must not see Alice's Bench Press goal
      const bobGet = await injectRaw({ method: 'GET', url: GOAL_URL, headers: AS_BOB });
      expect(bobGet.statusCode).toBe(200);
      const bobGoals = bobGet.json() as { lift: string }[];
      expect(bobGoals.some((g) => g.lift === 'Bench Press')).toBe(false);

      // DB layer — Alice's row exists, Bob's does not
      const aliceRow = await prisma.strengthGoal.findFirst({
        where: { userId: USER_ALICE, program: SEED_PROGRAM, lift: 'Bench Press' },
      });
      expect(aliceRow).not.toBeNull();

      const bobRow = await prisma.strengthGoal.findFirst({
        where: { userId: USER_BOB, program: SEED_PROGRAM, lift: 'Bench Press' },
      });
      expect(bobRow).toBeNull();
    });
  });

  describe('lift metadata (DB)', () => {
    it('PATCH metadata persists and GET returns updated values', async () => {
      const patchRes = await patchJson('/lifts/Squat/metadata', {
        muscleGroups: ['Quads', 'Glutes'],
        substitutions: ['Leg Press'],
        foundational: true,
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({
        muscleGroups: ['Quads', 'Glutes'],
        substitutions: ['Leg Press'],
        foundational: true,
      });

      const getRes = await get('/lifts/Squat/metadata');
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json()).toMatchObject({
        muscleGroups: ['Quads', 'Glutes'],
        substitutions: ['Leg Press'],
        foundational: true,
      });

      const row = await prisma.liftMetadata.findFirst({
        where: { userId: TEST_USER, lift: 'Squat' },
      });
      expect(row).not.toBeNull();
      expect(row?.foundational).toBe(true);
    });

    it('user isolation — lift metadata is scoped to userId', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
        app.getHttpAdapter().getInstance(),
      );
      const AS_ALICE = { authorization: `Bearer ${USER_ALICE}` };
      const AS_BOB = { authorization: `Bearer ${USER_BOB}` };

      // Alice sets metadata for Deadlift
      const alicePatch = await injectRaw({
        method: 'PATCH',
        url: '/lifts/Deadlift/metadata',
        headers: { 'content-type': 'application/json', ...AS_ALICE },
        payload: JSON.stringify({ muscleGroups: ['Hamstrings'], foundational: true }),
      });
      expect(alicePatch.statusCode).toBe(200);

      // Bob GETs Deadlift metadata — must see empty defaults
      const bobGet = await injectRaw({ method: 'GET', url: '/lifts/Deadlift/metadata', headers: AS_BOB });
      expect(bobGet.statusCode).toBe(200);
      const bobBody = bobGet.json() as { muscleGroups: string[]; foundational: boolean };
      expect(bobBody.muscleGroups).toEqual([]);
      expect(bobBody.foundational).toBe(false);

      // DB layer — Alice's row exists, Bob's does not
      const aliceRow = await prisma.liftMetadata.findFirst({
        where: { userId: USER_ALICE, lift: 'Deadlift' },
      });
      expect(aliceRow).not.toBeNull();

      const bobRow = await prisma.liftMetadata.findFirst({
        where: { userId: USER_BOB, lift: 'Deadlift' },
      });
      expect(bobRow).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // CSV import
  // ---------------------------------------------------------------------------

  describe('POST /programs/:program/lift-records/import', () => {
    const IMPORT_URL = `/programs/${SEED_PROGRAM}/lift-records/import`;

    // Resolve fixture path relative to the monorepo root (packages/core/tests/fixtures)
    const FIXTURE_PATH = path.resolve(
      __dirname,
      '../../../../packages/core/tests/fixtures/lift_records.csv',
    );

    beforeEach(async () => {
      // Start each import test with a clean slate for this user's lift records
      await prisma.liftRecord.deleteMany({ where: { userId: TEST_USER, program: SEED_PROGRAM } });
    });

    it('happy path — imports the full fixture CSV and returns a written count', async () => {
      const csvContent = fs.readFileSync(FIXTURE_PATH, 'utf8');

      const res = await postCsv(IMPORT_URL, csvContent);
      expect(res.statusCode).toBe(201);

      const body = res.json() as { written: number; skipped: { row: number; naturalKey: string }[] };
      expect(body.written).toBeGreaterThan(0);
      expect(Array.isArray(body.skipped)).toBe(true);

      // Verify rows actually landed in the DB
      const dbCount = await prisma.liftRecord.count({ where: { userId: TEST_USER, program: SEED_PROGRAM } });
      expect(dbCount).toBe(body.written);
    });

    // Regression for issue #884, against real fixture data rather than a synthetic
    // case: this CSV contains a genuine same-key-different-date collision — cycle
    // 37 / workout 2 / "BB Row" (canonical: "barbell-row") / set 1 exists on both
    // 12/16/2025 (175x7) and 1/12/2024 (202.5x8), the exact numbers cited in the
    // issue. Before the fix, the database's own unique constraint made it
    // physically impossible to store both; this test fails on the pre-fix schema
    // and passes once `date` joins the constraint.
    it('imports both sides of a real same-key-different-date collision', async () => {
      const csvContent = fs.readFileSync(FIXTURE_PATH, 'utf8');

      const res = await postCsv(IMPORT_URL, csvContent);
      expect(res.statusCode).toBe(201);

      const rows = await prisma.liftRecord.findMany({
        where: {
          userId: TEST_USER,
          program: SEED_PROGRAM,
          cycleNum: 37,
          workoutNum: 2,
          lift: 'barbell-row',
          setNum: 1,
        },
        orderBy: { date: 'asc' },
      });

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => [r.date.toISOString().slice(0, 10), r.weight, r.reps])).toEqual([
        ['2024-01-12', 202.5, 8],
        ['2025-12-16', 175, 7],
      ]);
    });

    it('re-import returns written=0 and skipped=all rows from first import', async () => {
      const csvContent = fs.readFileSync(FIXTURE_PATH, 'utf8');

      // First import
      const first = await postCsv(IMPORT_URL, csvContent);
      expect(first.statusCode).toBe(201);
      const firstBody = first.json() as { written: number; skipped: { row: number; naturalKey: string }[] };

      // Second import of the same file
      const second = await postCsv(IMPORT_URL, csvContent);
      expect(second.statusCode).toBe(201);
      const secondBody = second.json() as { written: number; skipped: { row: number; naturalKey: string }[] };

      expect(secondBody.written).toBe(0);
      // Core invariant: nothing new is written. The exact skipped count
      // includes seed-record collisions and is implementation-dependent;
      // assert only that every row that succeeded on first pass is now
      // accounted for as a skip on second pass.
      expect(secondBody.skipped.length).toBeGreaterThanOrEqual(firstBody.written);
    });

    it('rejects a file with validation errors and writes nothing', async () => {
      // Build a minimal CSV with two bad rows:
      //   row 1: weight is not a number
      //   row 2: unknown lift abbreviation
      const badCsv = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        'RPT,38,1,12/29/2025,Squat,1,not-a-number,8,',
        'RPT,38,1,12/29/2025,UnknownLift,2,180,8,',
      ].join('\n');

      const before = await prisma.liftRecord.count({
        where: { userId: TEST_USER, program: SEED_PROGRAM },
      });

      const res = await postCsv(IMPORT_URL, badCsv);
      expect(res.statusCode).toBe(400);

      const body = res.json() as { message: string; errors: { row: number; field?: string; message: string }[] };
      expect(body.errors.length).toBeGreaterThanOrEqual(2);
      // Errors should cover distinct field types
      const fields = body.errors.map((e) => e.field).filter(Boolean);
      expect(fields).toContain('weight');
      expect(fields).toContain('lift');

      // Nothing written
      const after = await prisma.liftRecord.count({
        where: { userId: TEST_USER, program: SEED_PROGRAM },
      });
      expect(after).toBe(before);
    });

    // Regression for issue #884's in-batch-duplicate fix: a second row within the
    // SAME file reusing an earlier row's full key (same date too) must be reported
    // as skipped rather than vanishing with no trace and no count anywhere.
    it('reports an in-batch duplicate row as skipped rather than silently dropping it', async () => {
      const csv = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        'RPT,90,1,6/1/2026,Squat,1,225,5,',
        'RPT,90,1,6/1/2026,Squat,1,999,1,', // exact duplicate key of row above
      ].join('\n');

      const res = await postCsv(IMPORT_URL, csv);
      expect(res.statusCode).toBe(201);

      const body = res.json() as { written: number; skipped: { row: number; naturalKey: string }[] };
      expect(body.written).toBe(1);
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0]?.row).toBe(2);

      const rows = await prisma.liftRecord.findMany({
        where: { userId: TEST_USER, program: SEED_PROGRAM, cycleNum: 90, workoutNum: 1, lift: 'back-squat', setNum: 1 },
      });
      // The first occurrence's data won, not the duplicate's.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.weight).toBe(225);
    });
  });

  // ---------------------------------------------------------------------------
  // Single-record POST/PATCH — de-risks the id-format and Prisma compound-unique
  // accessor rename from issue #884 end-to-end against a real DB, not just mocks.
  // ---------------------------------------------------------------------------

  describe('POST/PATCH /programs/:program/lift-records (single record, DB)', () => {
    const LIFT_RECORDS_URL = `/programs/${SEED_PROGRAM}/lift-records`;

    beforeEach(async () => {
      await prisma.liftRecord.deleteMany({ where: { userId: TEST_USER, program: SEED_PROGRAM } });
    });

    it('PATCHes the record it just POSTed, addressed by the id the POST returned', async () => {
      const createRes = await postJson(LIFT_RECORDS_URL, {
        program: SEED_PROGRAM,
        cycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Overhead Press',
        setNum: 1,
        weight: 95,
        reps: 5,
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json() as { id: string };

      const patchRes = await patchJson(
        `${LIFT_RECORDS_URL}/${encodeURIComponent(created.id)}`,
        { weight: 100 },
      );
      expect(patchRes.statusCode).toBe(200);
      expect((patchRes.json() as { weight: number }).weight).toBe(100);

      const row = await prisma.liftRecord.findFirst({
        where: { userId: TEST_USER, program: SEED_PROGRAM, cycleNum: 4, workoutNum: 1, setNum: 1 },
      });
      expect(row?.weight).toBe(100);
    });

    // Regression for issue #884's single-record fix (task 6): a colliding write
    // with DIFFERENT data (a genuine conflict, not a retry of the same write)
    // must be rejected loudly, not silently no-op with a 201.
    it('returns 409 when the write collides with different data on an already-logged set', async () => {
      const base = {
        program: SEED_PROGRAM,
        cycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Overhead Press',
        setNum: 1,
      };
      const first = await postJson(LIFT_RECORDS_URL, { ...base, weight: 95, reps: 5 });
      expect(first.statusCode).toBe(201);

      const second = await postJson(LIFT_RECORDS_URL, { ...base, weight: 100, reps: 3 });
      expect(second.statusCode).toBe(409);

      const rows = await prisma.liftRecord.findMany({
        where: { userId: TEST_USER, program: SEED_PROGRAM, cycleNum: 4, workoutNum: 1, setNum: 1 },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.weight).toBe(95);
    });

    // A retry whose response was lost (timeout, dropped connection) resubmits
    // identical data -- that must succeed idempotently (the existing record,
    // 201) rather than leave the client permanently stuck on a conflict it has
    // no way to resolve, and must not create a duplicate row.
    it('returns the existing record instead of 409 when the retry is identical', async () => {
      const body = {
        program: SEED_PROGRAM,
        cycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Overhead Press',
        setNum: 1,
        weight: 95,
        reps: 5,
      };
      const first = await postJson(LIFT_RECORDS_URL, body);
      expect(first.statusCode).toBe(201);

      const second = await postJson(LIFT_RECORDS_URL, body);
      expect(second.statusCode).toBe(201);
      expect((second.json() as { weight: number }).weight).toBe(95);

      const count = await prisma.liftRecord.count({
        where: { userId: TEST_USER, program: SEED_PROGRAM, cycleNum: 4, workoutNum: 1, setNum: 1 },
      });
      expect(count).toBe(1);
    });

    it('does not collide when the same set is logged on a different date', async () => {
      const base = {
        program: SEED_PROGRAM,
        cycleNum: 4,
        workoutNum: 1,
        lift: 'Overhead Press',
        setNum: 1,
        weight: 95,
        reps: 5,
      };
      const first = await postJson(LIFT_RECORDS_URL, { ...base, date: '2025-12-16' });
      expect(first.statusCode).toBe(201);

      const second = await postJson(LIFT_RECORDS_URL, { ...base, date: '2024-01-12' });
      expect(second.statusCode).toBe(201);

      const count = await prisma.liftRecord.count({
        where: { userId: TEST_USER, program: SEED_PROGRAM, cycleNum: 4, workoutNum: 1, setNum: 1 },
      });
      expect(count).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Body weight — in-memory adapter only (no Prisma adapter exists); exercises
  // the HTTP contract end-to-end even though no DB assertion is possible.
  // ---------------------------------------------------------------------------

  describe('body-weight endpoints', () => {
    const AS_BW = { authorization: `Bearer ${USER_BW}` };
    const BW_URL = `/programs/${SEED_PROGRAM}/body-weight`;

    it('GET /body-weight/latest returns 404 when nothing has been recorded for this program', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const res = await injectRaw({ method: 'GET', url: `${BW_URL}/latest`, headers: AS_BW });
      expect(res.statusCode).toBe(404);
    });

    it('POST body-weight returns 201 and GET /latest reflects the entry', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const postRes = await injectRaw({
        method: 'POST',
        url: BW_URL,
        headers: { 'content-type': 'application/json', ...AS_BW },
        payload: JSON.stringify({ date: '2026-05-01', weight: 185, unit: 'lbs' }),
      });
      expect(postRes.statusCode).toBe(201);

      const getRes = await injectRaw({ method: 'GET', url: `${BW_URL}/latest`, headers: AS_BW });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json()).toMatchObject({ date: '2026-05-01', weight: 185, unit: 'lbs' });
    });
  });

  // ---------------------------------------------------------------------------
  // History page scenario — exercises both endpoints the /history page calls
  // together and cross-references the data they return.
  // ---------------------------------------------------------------------------

  describe('history page scenario (DB)', () => {
    const AS_HIST = { authorization: `Bearer ${USER_HIST}` };

    beforeAll(async () => {
      const dash = seedCycleDashboard();
      await prisma.cycleDashboard.create({
        data: {
          userId: USER_HIST,
          program: SEED_PROGRAM,
          cycleUnit: dash.cycleUnit,
          cycleNum: 1,
          cycleDate: dash.cycleDate,
          sheetName: dash.sheetName,
          cycleStartWeekday: dash.cycleStartWeekday,
          programType: dash.programType ?? null,
        },
      });
      await prisma.liftRecord.createMany({
        data: [
          { userId: USER_HIST, program: SEED_PROGRAM, cycleNum: 1, workoutNum: 1, date: new Date('2026-04-20'), lift: 'Squat', setNum: 1, weight: 205, reps: 5, notes: '' },
          { userId: USER_HIST, program: SEED_PROGRAM, cycleNum: 1, workoutNum: 2, date: new Date('2026-04-22'), lift: 'Bench Press', setNum: 1, weight: 145, reps: 5, notes: '' },
        ],
      });
      await prisma.trainingMaxHistory.createMany({
        data: [
          { userId: USER_HIST, program: SEED_PROGRAM, lift: 'Squat',       weight: 315, date: new Date('2026-04-20'), isPR: false, source: 'program', goalMet: false },
          { userId: USER_HIST, program: SEED_PROGRAM, lift: 'Bench Press', weight: 225, date: new Date('2026-04-20'), isPR: true,  source: 'program', goalMet: false },
        ],
      });
    });

    afterAll(async () => {
      await prisma.liftRecord.deleteMany({ where: { userId: USER_HIST } });
      await prisma.trainingMaxHistory.deleteMany({ where: { userId: USER_HIST } });
      await prisma.cycleDashboard.deleteMany({ where: { userId: USER_HIST } });
    });

    it('GET lift-records returns 2 seeded records for current cycle', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const res = await injectRaw({ method: 'GET', url: `/programs/${SEED_PROGRAM}/lift-records`, headers: AS_HIST });
      expect(res.statusCode).toBe(200);
      const records = res.json() as { lift: string; cycleNum: number }[];
      expect(records).toHaveLength(2);
      expect(records.every((r) => r.cycleNum === 1)).toBe(true);
    });

    it('GET training-maxes/history returns 2 seeded entries and respects isPR', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const res = await injectRaw({ method: 'GET', url: `/programs/${SEED_PROGRAM}/training-maxes/history`, headers: AS_HIST });
      expect(res.statusCode).toBe(200);
      const { entries } = res.json() as { entries: { lift: string; isPR: boolean }[] };
      expect(entries).toHaveLength(2);
      expect(entries.some((e) => e.isPR)).toBe(true);
    });

    it('every lift in TM history also appears in lift records (cross-reference)', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

      const liftRes = await injectRaw({ method: 'GET', url: `/programs/${SEED_PROGRAM}/lift-records`, headers: AS_HIST });
      const records = liftRes.json() as { lift: string }[];

      const histRes = await injectRaw({ method: 'GET', url: `/programs/${SEED_PROGRAM}/training-maxes/history`, headers: AS_HIST });
      const { entries } = histRes.json() as { entries: { lift: string }[] };

      const recordedLifts = new Set(records.map((r) => r.lift));
      for (const e of entries) {
        expect(recordedLifts.has(e.lift)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // User settings — Prisma-backed; no in-memory variant.
  // ---------------------------------------------------------------------------

  describe('user settings (DB)', () => {
    const AS_SETT = { authorization: `Bearer ${USER_SETT}` };

    it('GET /users/me/settings returns null activeProgram for a new user', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const res = await injectRaw({ method: 'GET', url: '/users/me/settings', headers: AS_SETT });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ activeProgram: null });
    });

    it('PATCH /users/me/settings updates activeProgram and persists to DB', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

      const patchRes = await injectRaw({
        method: 'PATCH',
        url: '/users/me/settings',
        headers: { 'content-type': 'application/json', ...AS_SETT },
        payload: JSON.stringify({ activeProgram: SEED_PROGRAM }),
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({ activeProgram: SEED_PROGRAM });

      const row = await prisma.userSettings.findFirst({ where: { userId: USER_SETT } });
      expect(row?.activeProgram).toBe(SEED_PROGRAM);

      const getRes = await injectRaw({ method: 'GET', url: '/users/me/settings', headers: AS_SETT });
      expect(getRes.json()).toMatchObject({ activeProgram: SEED_PROGRAM });
    });

    it('PATCH /users/me/settings updates unit and persists to DB', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

      const patchRes = await injectRaw({
        method: 'PATCH',
        url: '/users/me/settings',
        headers: { 'content-type': 'application/json', ...AS_SETT },
        payload: JSON.stringify({ unit: 'kg' }),
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({ unit: 'kg' });

      const row = await prisma.userSettings.findFirst({ where: { userId: USER_SETT } });
      expect(row?.unit).toBe('kg');

      const getRes = await injectRaw({ method: 'GET', url: '/users/me/settings', headers: AS_SETT });
      expect(getRes.json()).toMatchObject({ unit: 'kg' });
    });

    it('user isolation — settings are scoped to userId', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const AS_OTHER = { authorization: `Bearer ${USER_SETT_OTHER}` };

      const res = await injectRaw({ method: 'GET', url: '/users/me/settings', headers: AS_OTHER });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ activeProgram: null });
    });
  });

  // ---------------------------------------------------------------------------
  // Custom programs — Prisma-backed; no in-memory variant.
  // ---------------------------------------------------------------------------

  describe('custom programs (DB)', () => {
    const AS_CUST = { authorization: `Bearer ${USER_CUST}` };

    const MINIMAL_SPEC = {
      week: 1,
      offset: 0,
      lift: 'Squat',
      increment: 5,
      order: 1,
      sets: 3,
      reps: 5,
      amrap: false,
      warmUpPct: '40/50/60/70/75/80',
      // 0.1 per-set drop over 3 sets → work %s [1, 0.9, 0.8], all positive. (A prior
      // value of 0.9 produced a negative final set; it survived only because this
      // block never generates a plan. The cross-field DTO guard now rejects it.)
      wtDecrementPct: 0.1,
      activation: 'standard',
    };

    it('GET /programs/custom returns empty array for a new user', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const res = await injectRaw({ method: 'GET', url: '/programs/custom', headers: AS_CUST });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('POST /programs/custom creates a program and GET lists it', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

      const createRes = await injectRaw({
        method: 'POST',
        url: '/programs/custom',
        headers: { 'content-type': 'application/json', ...AS_CUST },
        payload: JSON.stringify({ name: 'My Test Program', description: 'A test', specs: [MINIMAL_SPEC] }),
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json() as { id: string; name: string };
      expect(created.name).toBe('My Test Program');

      const listRes = await injectRaw({ method: 'GET', url: '/programs/custom', headers: AS_CUST });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json() as { id: string; name: string }[];
      expect(list.some((p) => p.id === created.id && p.name === 'My Test Program')).toBe(true);

      const row = await prisma.customProgram.findFirst({ where: { userId: USER_CUST, name: 'My Test Program' } });
      expect(row).not.toBeNull();
    });

    it('user isolation — custom programs are scoped to userId', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const AS_OTHER = { authorization: `Bearer ${USER_CUST_OTHER}` };

      const res = await injectRaw({ method: 'GET', url: '/programs/custom', headers: AS_OTHER });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('user isolation — another user cannot read the owner\'s custom program SPEC', async () => {
      // Regression guard for the cross-user spec leak (#434): GET /programs/:uuid/spec
      // resolves through HybridLiftingProgramSpecRepository.getCustomSpec, which must
      // scope by the owning program's userId. A bare where:{ programId } would return
      // the owner's rows to any caller who knows the UUID. This asserts the fix at the
      // real Postgres layer (the unit spec only checks the query shape).
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

      // Owner creates a program with a spec row.
      const createRes = await injectRaw({
        method: 'POST',
        url: '/programs/custom',
        headers: { 'content-type': 'application/json', ...AS_CUST },
        payload: JSON.stringify({ name: 'Spec Isolation Program', specs: [MINIMAL_SPEC] }),
      });
      expect(createRes.statusCode).toBe(201);
      const programId = (createRes.json() as { id: string }).id;

      // Owner sees the spec.
      const ownerSpec = await injectRaw({
        method: 'GET',
        url: `/programs/${programId}/spec`,
        headers: AS_CUST,
      });
      expect(ownerSpec.statusCode).toBe(200);
      expect((ownerSpec.json() as unknown[]).length).toBeGreaterThan(0);

      // A different user requesting the same UUID gets an empty spec, not the owner's rows.
      const otherSpec = await injectRaw({
        method: 'GET',
        url: `/programs/${programId}/spec`,
        headers: { authorization: `Bearer ${USER_CUST_OTHER}` },
      });
      expect(otherSpec.statusCode).toBe(200);
      expect(otherSpec.json()).toEqual([]);
    });

    it('enforces the customProgramSpec natural-key unique constraint (#488)', async () => {
      // The migration adds @@unique([programId, week, offset, lift, order]); a second
      // row on the same natural key must be rejected at the DB layer (P2002). That
      // constraint is what makes saveProgramSpec's upsert race-safe against two
      // concurrent imports both passing find-then-create.
      const program = await prisma.customProgram.create({
        data: { userId: USER_CUST, name: 'Dup Guard Program' },
      });
      const specRow = {
        programId: program.id,
        week: MINIMAL_SPEC.week,
        offset: MINIMAL_SPEC.offset,
        lift: MINIMAL_SPEC.lift,
        increment: MINIMAL_SPEC.increment,
        order: MINIMAL_SPEC.order,
        sets: MINIMAL_SPEC.sets,
        reps: MINIMAL_SPEC.reps,
        amrap: MINIMAL_SPEC.amrap,
        warmUpPct: MINIMAL_SPEC.warmUpPct,
        wtDecrementPct: MINIMAL_SPEC.wtDecrementPct,
        activation: MINIMAL_SPEC.activation,
      };
      await prisma.customProgramSpec.create({ data: specRow });
      // Same natural key, different config → unique violation, not a duplicate row.
      await expect(
        prisma.customProgramSpec.create({ data: { ...specRow, increment: 99 } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // ---------------------------------------------------------------------------
  // Custom lifts — Prisma-backed (PrismaCustomLiftRepository). The in-memory
  // e2e (custom-lift.e2e.spec.ts) covers the HTTP contract against the in-memory
  // adapter; this block exercises the Prisma adapter against real Postgres,
  // including the P2002 -> 409 conflict path and — critically — the userId guard
  // on update/delete (the PK is `id` alone, so a bare where:{id} would let one
  // user mutate another's lift). Order-sensitive within the block.
  // ---------------------------------------------------------------------------

  describe('custom lifts (DB)', () => {
    const AS_OWNER = { authorization: `Bearer ${USER_CLIFT}` };
    const AS_OTHER = { authorization: `Bearer ${USER_CLIFT_OTHER}` };
    const injectRaw = () =>
      app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

    let liftId = '';

    it('POST /lifts/custom creates a row (uuid id, isCustom) and persists to DB', async () => {
      const res = await injectRaw()({
        method: 'POST',
        url: '/lifts/custom',
        headers: { 'content-type': 'application/json', ...AS_OWNER },
        payload: JSON.stringify({
          name: 'Zercher Squat',
          classification: 'compound',
          movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        id: string; name: string; isCustom: boolean; createdAt: string; userId?: string;
      };
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.name).toBe('Zercher Squat');
      expect(body.isCustom).toBe(true);
      expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body).not.toHaveProperty('userId');
      liftId = body.id;

      const row = await prisma.customLift.findFirst({ where: { id: liftId } });
      expect(row).not.toBeNull();
      expect(row?.userId).toBe(USER_CLIFT);
      expect(row?.classification).toBe('compound');
      expect(row?.patterns).toEqual(['squat']);
      expect(row?.jointActions).toEqual(['flexion', 'extension']);
      expect(row?.complexity).toBe('compound');
    });

    it('GET /lifts/custom lists the created lift for the owner', async () => {
      const res = await injectRaw()({ method: 'GET', url: '/lifts/custom', headers: AS_OWNER });
      expect(res.statusCode).toBe(200);
      const list = res.json() as { id: string; name: string }[];
      expect(list.some((l) => l.id === liftId && l.name === 'Zercher Squat')).toBe(true);
    });

    it('POST duplicate name for same user returns 409 (Prisma P2002 -> conflict)', async () => {
      const res = await injectRaw()({
        method: 'POST',
        url: '/lifts/custom',
        headers: { 'content-type': 'application/json', ...AS_OWNER },
        payload: JSON.stringify({ name: 'Zercher Squat', classification: 'accessory' }),
      });
      expect(res.statusCode).toBe(409);
    });

    it('PATCH /lifts/custom/:id updates the owner\'s lift and persists', async () => {
      const res = await injectRaw()({
        method: 'PATCH',
        url: `/lifts/custom/${liftId}`,
        headers: { 'content-type': 'application/json', ...AS_OWNER },
        payload: JSON.stringify({ name: 'Zercher Squat (SSB)', classification: 'accessory' }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: liftId, name: 'Zercher Squat (SSB)', classification: 'accessory' });

      const row = await prisma.customLift.findFirst({ where: { id: liftId } });
      expect(row?.name).toBe('Zercher Squat (SSB)');
      expect(row?.classification).toBe('accessory');
    });

    it('user isolation — another user cannot see, modify, or delete the lift', async () => {
      // OTHER's list must not include OWNER's lift.
      const listRes = await injectRaw()({ method: 'GET', url: '/lifts/custom', headers: AS_OTHER });
      expect(listRes.statusCode).toBe(200);
      expect((listRes.json() as { id: string }[]).some((l) => l.id === liftId)).toBe(false);

      // OTHER's PATCH on OWNER's id -> 404 (userId guard, not a bare where:{id}).
      const patchRes = await injectRaw()({
        method: 'PATCH',
        url: `/lifts/custom/${liftId}`,
        headers: { 'content-type': 'application/json', ...AS_OTHER },
        payload: JSON.stringify({ name: 'HACKED' }),
      });
      expect(patchRes.statusCode).toBe(404);

      // OTHER's DELETE on OWNER's id -> 404.
      const delRes = await injectRaw()({ method: 'DELETE', url: `/lifts/custom/${liftId}`, headers: AS_OTHER });
      expect(delRes.statusCode).toBe(404);

      // DB layer — the row is untouched: still owned by OWNER with the pre-attack name.
      const row = await prisma.customLift.findFirst({ where: { id: liftId } });
      expect(row).not.toBeNull();
      expect(row?.userId).toBe(USER_CLIFT);
      expect(row?.name).toBe('Zercher Squat (SSB)');
    });

    it('PATCH unknown id returns 404', async () => {
      const res = await injectRaw()({
        method: 'PATCH',
        url: '/lifts/custom/00000000-0000-0000-0000-000000000000',
        headers: { 'content-type': 'application/json', ...AS_OWNER },
        payload: JSON.stringify({ name: 'nope' }),
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /lifts/custom/:id removes the owner\'s row', async () => {
      const res = await injectRaw()({ method: 'DELETE', url: `/lifts/custom/${liftId}`, headers: AS_OWNER });
      expect(res.statusCode).toBe(204);

      const row = await prisma.customLift.findFirst({ where: { id: liftId } });
      expect(row).toBeNull();
    });

    it('DELETE unknown id returns 404', async () => {
      const res = await injectRaw()({ method: 'DELETE', url: `/lifts/custom/${liftId}`, headers: AS_OWNER });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Switch program — Prisma-backed; no in-memory variant.
  // Order-sensitive within this block.
  // ---------------------------------------------------------------------------

  describe('POST /programs/:program/switch (DB)', () => {
    const AS_SW = { authorization: `Bearer ${USER_SW}` };

    it('initializes a cycle and sets activeProgram for a user with no prior cycle', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

      const res = await injectRaw({ method: 'POST', url: `/programs/${SEED_PROGRAM}/switch`, headers: AS_SW });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { activeProgram: string; cycleNum: number };
      expect(body.activeProgram).toBe(SEED_PROGRAM);
      expect(body.cycleNum).toBe(1);

      const settingsRow = await prisma.userSettings.findFirst({ where: { userId: USER_SW } });
      expect(settingsRow?.activeProgram).toBe(SEED_PROGRAM);

      const cycleRow = await prisma.cycleDashboard.findFirst({ where: { userId: USER_SW, program: SEED_PROGRAM } });
      expect(cycleRow).not.toBeNull();
      expect(cycleRow?.cycleNum).toBe(1);
    });

    it('returns existing cycleNum when CycleDashboard already exists', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

      // Previous test created the dashboard — switching again must not reinitialize.
      const res = await injectRaw({ method: 'POST', url: `/programs/${SEED_PROGRAM}/switch`, headers: AS_SW });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ activeProgram: SEED_PROGRAM, cycleNum: 1 });
    });

    it('returns 403 when switching to a UUID-format program not owned by the user', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());
      const fakeUuid = '00000000-0000-0000-0000-000000000000';

      const res = await injectRaw({ method: 'POST', url: `/programs/${fakeUuid}/switch`, headers: AS_SW });
      expect(res.statusCode).toBe(403);
    });
  });
});
