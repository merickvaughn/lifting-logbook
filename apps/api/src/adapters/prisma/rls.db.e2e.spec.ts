// Real-Postgres E2E suite for Row-Level Security (issue #511).
//
// Postgres is provisioned by jest.global-setup.js (Testcontainers locally; CI passthrough),
// which also provisions the `lifting_app` role's login password and exposes both connection
// strings directly (issue #646): LIFTING_TC_DATABASE_URL (the restricted lifting_app role — the
// default every DB E2E suite now uses) and LIFTING_TC_OWNER_DATABASE_URL (the superuser/owner
// opt-in). This suite:
//   1. connects a second Prisma client AS lifting_app to prove the policies actually constrain a
//      non-superuser caller — the enforcement tests below assert the policies themselves hold,
//      which merely connecting as the (now-default) restricted role elsewhere cannot substitute for.
//
// Seeding and cleanup use the owner client (superuser → bypasses RLS, so it can write any user's
// rows). Enforcement assertions use the lifting_app client.
import 'reflect-metadata';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { ClsModule, ClsService } from 'nestjs-cls';
import { lastValueFrom, from } from 'rxjs';
import { AppModule } from '../../app.module';
import { PrismaService } from './prisma.service';
import { PrismaRepositoryFactory } from './prisma-repository-factory';
import { RlsInterceptor } from './rls.interceptor';
import { RLS_TX_CLIENT } from './rls-context';
import { runBatch } from './prisma-tx.util';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_TC_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_TC_URL ? describe : describe.skip;
// Guaranteed-string forms for use inside the guarded describe blocks (they only run when
// both sentinels are set, so the '' fallback is never exercised — it just avoids a non-null
// assertion and keeps Prisma's `url: string` type satisfied).
const OWNER_URL = OWNER_TC_URL ?? '';
const APP_DB_URL = APP_ROLE_URL ?? '';

// The beforeAll below connects an owner PrismaClient and seeds fixtures. In isolation it
// finishes in ~2s, but under a full-suite Windows `turbo run test` it contends with the
// CSV-fixture-heavy web/core suites and intermittently blows past Jest's 5s default hook
// timeout (an isolation-only flake — apps/api/jest.config.js does not extend the win32-capped
// base config). 30s gives ample headroom over the contended case while still failing fast on a
// genuine hang (Testcontainers readiness is already bounded in jest.global-setup.js). See #567.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_ALICE = 'rls-e2e-alice';
const USER_BOB = 'rls-e2e-bob';
const PROGRAM = 'rls-e2e-program';

/** Runs `body` inside a transaction with app.current_user_id set to `userId` (or unset if null). */
async function asUser<T>(
  client: PrismaClient,
  userId: string | null,
  body: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    if (userId !== null) {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    }
    return body(tx as unknown as PrismaClient);
  });
}

describeOrSkip('Row-Level Security (e2e, lifting_app role)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;
  let aliceProgramId: string;

  const cleanup = async () => {
    await owner.customProgram.deleteMany({ where: { userId: { in: [USER_ALICE, USER_BOB] } } });
    await owner.trainingMax.deleteMany({ where: { userId: { in: [USER_ALICE, USER_BOB] } } });
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

    // jest.global-setup.js already provisioned lifting_app's login password (issue #646),
    // so the app-role client can connect directly against the sentinel it exposed.
    appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });

    await cleanup();

    // Seed both users' training maxes via the owner (RLS-bypassing) connection.
    await owner.trainingMax.createMany({
      data: [
        { userId: USER_ALICE, program: PROGRAM, lift: 'squat', weight: 300, dateUpdated: new Date() },
        { userId: USER_BOB, program: PROGRAM, lift: 'squat', weight: 200, dateUpdated: new Date() },
      ],
    });

    // Seed a custom program + spec for Alice (custom_program_spec has no userId — it is isolated
    // through its parent program's userId).
    const aliceProgram = await owner.customProgram.create({
      data: { userId: USER_ALICE, name: 'Alice RLS Program' },
    });
    aliceProgramId = aliceProgram.id;
    await owner.customProgramSpec.create({
      data: {
        programId: aliceProgramId,
        week: 1,
        offset: 0,
        lift: 'squat',
        increment: 5,
        order: 1,
        sets: 3,
        reps: 5,
        warmUpPct: '40/50/60',
        wtDecrementPct: 10,
        activation: 'standard',
      },
    });
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup().catch(() => undefined);
    await appDb?.$disconnect().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('the app-role connection is NOT a superuser and does NOT bypass RLS', async () => {
    // Guards against a future regression where this suite silently reconnects as a superuser
    // (which would make every assertion below pass without proving anything).
    const rows = await appDb.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('isolates reads by GUC even on an unscoped findMany (proves RLS, not app filtering)', async () => {
    const rows = await asUser(appDb, USER_ALICE, (tx) =>
      // Deliberately NO where: { userId } — only RLS stands between Alice and Bob's rows.
      tx.trainingMax.findMany({ where: { program: PROGRAM } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(USER_ALICE);
  });

  it('is fail-closed: with the GUC unset, queries return zero rows', async () => {
    const rows = await asUser(appDb, null, (tx) =>
      tx.trainingMax.findMany({ where: { program: PROGRAM } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects an INSERT whose userId does not match the GUC (WITH CHECK)', async () => {
    await expect(
      asUser(appDb, USER_ALICE, (tx) =>
        tx.trainingMax.create({
          data: { userId: USER_BOB, program: PROGRAM, lift: 'bench', weight: 1, dateUpdated: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it('isolates custom_program_spec through its parent program FK policy', async () => {
    const asBob = await asUser(appDb, USER_BOB, (tx) =>
      tx.customProgramSpec.findMany({ where: { programId: aliceProgramId } }),
    );
    expect(asBob).toHaveLength(0);

    const asAlice = await asUser(appDb, USER_ALICE, (tx) =>
      tx.customProgramSpec.findMany({ where: { programId: aliceProgramId } }),
    );
    expect(asAlice).toHaveLength(1);
  });

  it('every table with a userId column has FORCE RLS enabled and at least one policy', async () => {
    // Generic coverage guard: catches the "added a userId table, forgot the policy" regression
    // class that the targeted tests above cannot — they only assert the specific tables they name.
    // Metadata views are role-independent, so the owner connection is fine here.
    const tables = await owner.$queryRaw<
      Array<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policy_count: number;
      }>
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'userId' AND NOT a.attisdropped
        )`;

    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect({ table: t.relname, rls: t.relrowsecurity, force: t.relforcerowsecurity }).toEqual({
        table: t.relname,
        rls: true,
        force: true,
      });
      expect({ table: t.relname, policies: t.policy_count }).toEqual({
        table: t.relname,
        policies: expect.any(Number),
      });
      expect(t.policy_count).toBeGreaterThanOrEqual(1);
    }

    // custom_program_spec has no userId (isolated via its parent program FK) so the query above
    // excludes it — assert it explicitly.
    const spec = await owner.$queryRaw<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policy_count: number }>
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'custom_program_spec'`;
    expect(spec[0]?.relrowsecurity).toBe(true);
    expect(spec[0]?.relforcerowsecurity).toBe(true);
    expect(spec[0]?.policy_count).toBeGreaterThanOrEqual(1);
  });

  it('runBatch stays isolated and atomic inside a request transaction (helper sequential path)', async () => {
    // Mirrors PrismaWorkoutRepository.saveWorkout / saveScheduledWorkouts under a request tx:
    // the injected client is a TransactionClient (no $transaction), so runBatch runs the ops
    // sequentially on the existing transaction — which carries Alice's GUC.
    await asUser(appDb, USER_ALICE, async (tx) => {
      await runBatch(tx, (db) => [
        db.trainingMax.deleteMany({ where: { program: PROGRAM, lift: 'squat' } }),
        db.trainingMax.create({
          data: { userId: USER_ALICE, program: PROGRAM, lift: 'squat', weight: 305, dateUpdated: new Date() },
        }),
      ]);
      return undefined;
    });

    // Bob's squat row must survive (Alice's deleteMany could not see it).
    const bobRow = await owner.trainingMax.findFirst({
      where: { userId: USER_BOB, program: PROGRAM, lift: 'squat' },
    });
    expect(bobRow?.weight).toBe(200);
    const aliceRow = await owner.trainingMax.findFirst({
      where: { userId: USER_ALICE, program: PROGRAM, lift: 'squat' },
    });
    expect(aliceRow?.weight).toBe(305);
  });
});

// Proves the request-path wiring end to end: RlsInterceptor opens a transaction, sets
// app.current_user_id to the request user, and exposes the transaction client via CLS so
// PrismaRepositoryFactory routes every repository query through it. Uses the owner connection
// (the GUC is observable regardless of superuser bypass — bypass only affects POLICY enforcement,
// which the suite above already covers).
describeOrSkip('RLS request wiring (interceptor + factory)', () => {
  let cls: ClsService;
  let prisma: PrismaService;
  let factory: PrismaRepositoryFactory;
  let interceptor: RlsInterceptor;

  beforeAll(async () => {
    process.env.DATABASE_URL = OWNER_URL; // allowed by jest.env.setup.js Proxy (== LIFTING_TC_OWNER_DATABASE_URL sentinel)
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [
        Reflector,
        {
          provide: PrismaService,
          useFactory: (clsService: ClsService) => new PrismaService(clsService),
          inject: [ClsService],
        },
      ],
    }).compile();
    await moduleRef.init();
    cls = moduleRef.get(ClsService);
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
    factory = new PrismaRepositoryFactory(prisma, cls);
    // RlsInterceptor resolves PrismaService lazily via ModuleRef (see rls.interceptor.ts) rather
    // than constructor injection, so the test module itself — which implements ModuleRef and
    // already has PrismaService registered above — stands in for the real one.
    interceptor = new RlsInterceptor(cls, moduleRef.get(Reflector), moduleRef);
  });

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
  });

  // Reflector.getAllAndOverride reads metadata off the handler/class, so they must be real
  // reflection targets (a function and a class), not undefined.
  const dummyHandler = function handler() {};
  class DummyController {}

  function httpContextFor(userId: string): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ user: { id: userId } }) }),
      getHandler: () => dummyHandler,
      getClass: () => DummyController,
    } as unknown as ExecutionContext;
  }

  it('sets app.current_user_id from request.user and routes the factory client through the tx', async () => {
    const observed: { uid: string | null } = { uid: 'unset' };

    const handler: CallHandler = {
      handle: () =>
        from(
          (async () => {
            // The factory must resolve the request transaction client out of CLS...
            await factory.forUser({ id: USER_ALICE, email: '', displayName: '', provider: 'dev' });
            const tx = cls.get(RLS_TX_CLIENT) as PrismaClient;
            const rows = await tx.$queryRaw<Array<{ uid: string | null }>>`
              SELECT current_setting('app.current_user_id', true) AS uid`;
            const first = rows[0];
            observed.uid = first ? first.uid : null;
            return 'ok';
          })(),
        ),
    };

    const result = await lastValueFrom(interceptor.intercept(httpContextFor(USER_ALICE), handler));
    expect(result).toBe('ok');
    expect(observed.uid).toBe(USER_ALICE);
  });

  it('clientForRequest() returns the request tx client inside a request and the base client outside', async () => {
    // Guards the path used by controllers that build repositories, or run raw queries, OUTSIDE
    // the factory (CustomProgramsController; SwitchProgramController's custom-program ownership
    // check). If this routing regresses, those controllers' queries run on the base connection
    // with no GUC and fail closed under lifting_app. Outside any CLS request, the base client
    // must be returned.
    expect(prisma.clientForRequest()).toBe(prisma);

    // Inside a CLS context with the interceptor's tx stashed, the tx client must be returned.
    await cls.run(async () => {
      const sentinelTx = { marker: 'request-tx' } as unknown as PrismaClient;
      cls.set(RLS_TX_CLIENT, sentinelTx);
      expect(prisma.clientForRequest()).toBe(sentinelTx);
    });

    // After the request scope ends, it falls back to the base client again.
    expect(prisma.clientForRequest()).toBe(prisma);
  });
});

// Proves the FULL request path — real AppModule, real AuthGuard, real RlsInterceptor, real
// PrismaRepositoryFactory — against the actual restricted lifting_app role. Neither block above
// covers this exact combination: the enforcement block above calls raw Prisma directly (no
// interceptor/factory/guard involved), and the wiring block above connects as the OWNER
// (superuser bypasses policy enforcement, so it can prove the GUC is *set* but not that a real
// write actually clears the policy). That gap is exactly what let issue #644 ship silently:
// RlsInterceptor's constructor-injected `@Optional() PrismaService` was permanently null (Nest
// instantiates APP_INTERCEPTOR-bound providers before this module's PrismaService factory is
// guaranteed to have run), so no request ever set app.current_user_id — reads on genuinely
// existing data silently returned "not found" (fail-closed), and every first-time INSERT was
// rejected with a 42501 row-level security violation. Every other DB E2E suite in this repo
// connects as the bootstrap superuser and could not have caught this.
describeOrSkip('RLS request wiring (interceptor + factory, full app boot)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

    // jest.global-setup.js already provisioned lifting_app's login password (issue #646).
    // This matches the LIFTING_TC_DATABASE_URL sentinel exactly, so jest.env.setup.js's Proxy
    // allows the write — PrismaService's env("DATABASE_URL") read resolves to a real,
    // RLS-enforcing connection instead of the owner/superuser one.
    process.env.DATABASE_URL = APP_DB_URL;

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  const inject = (opts: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }) => app.getHttpAdapter().getInstance().inject(opts);

  it('creates a first-time row for a brand-new user (regression test for #644)', async () => {
    const userId = `rls-e2e-fullapp-init-${Date.now()}`;
    const res = await inject({
      method: 'POST',
      url: '/programs/leangains/cycles/initialize',
      headers: { authorization: `Bearer ${userId}`, 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(res.statusCode).toBe(201);
    await owner.cycleDashboard.deleteMany({ where: { userId } });
  });

  it('reads back data that genuinely exists instead of failing closed (regression test for #644)', async () => {
    const userId = `rls-e2e-fullapp-read-${Date.now()}`;
    await owner.cycleDashboard.create({
      data: {
        userId,
        program: 'leangains',
        cycleUnit: 'week',
        cycleNum: 1,
        cycleDate: new Date(),
        sheetName: 'leangains_Cycle_1_seed',
        cycleStartWeekday: 'Friday',
        programType: 'leangains',
      },
    });

    const res = await inject({
      method: 'GET',
      url: '/programs/leangains/cycles/current',
      headers: { authorization: `Bearer ${userId}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).program).toBe('leangains');
    await owner.cycleDashboard.deleteMany({ where: { userId } });
  });

  // switchProgram (SwitchProgramController) is a separate DI-wired path from
  // cycles/initialize above — it builds its repos via `this.prisma.clientForRequest()`
  // directly rather than solely through PrismaRepositoryFactory. It has an existing
  // create-new-cycle test in programs.db.e2e.spec.ts, but that suite (like every DB E2E
  // suite except this file) connects as the bootstrap superuser, which bypasses RLS.
  // #650 (the onboarding activeProgram fix) made this the primary path onboarding now
  // depends on, so it needs the same full-app-boot-under-lifting_app coverage cycles/
  // initialize got in #645 — otherwise this endpoint carries the same class of blind
  // spot that let #644 ship undetected.
  it('switchProgram creates a first-time cycle and sets activeProgram under the restricted role', async () => {
    const userId = `rls-e2e-fullapp-switch-${Date.now()}`;
    const res = await inject({
      method: 'POST',
      url: '/programs/leangains/switch',
      headers: { authorization: `Bearer ${userId}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ activeProgram: 'leangains', cycleNum: 1 });

    await owner.cycleDashboard.deleteMany({ where: { userId } });
    await owner.userSettings.deleteMany({ where: { userId } });
  });

  // Regression coverage for #647: the new DELETE cycles/current endpoint (added to
  // support a self-cleaning staging Playwright test) deletes through the same
  // factory/repos path as every other request. Proves the deleteMany calls are
  // genuinely RLS-scoped under the restricted lifting_app role — not merely
  // filtered by an application-level WHERE clause that happens to look correct —
  // exactly the risk class that let #644 ship silently.
  it('deletes a cycle scoped to the requesting user only, under real RLS (regression coverage for #647)', async () => {
    // deleteCurrentCycle issues five scoped deletes (CycleDashboard, LiftRecord,
    // TrainingMax, TrainingMaxHistory, CycleScheduledWorkout). Seeding all five
    // for both users — not just the dashboard — matters because #644 was a
    // per-repository DI-wiring failure, not a missing-policy failure: a future
    // regression where one specific repository fails to route through the
    // request-scoped RLS transaction would not be caught if this test only ever
    // exercised an empty table for that repository.
    const userId = `rls-e2e-fullapp-delete-${Date.now()}`;
    const otherUserId = `rls-e2e-fullapp-delete-other-${Date.now()}`;
    const PROGRAM = 'leangains';

    const seedAllTables = async (uid: string) => {
      await owner.cycleDashboard.create({
        data: {
          userId: uid,
          program: PROGRAM,
          cycleUnit: 'week',
          cycleNum: 1,
          cycleDate: new Date(),
          sheetName: `leangains_Cycle_1_${uid}`,
          cycleStartWeekday: 'Friday',
          programType: PROGRAM,
        },
      });
      await owner.liftRecord.create({
        data: {
          userId: uid,
          program: PROGRAM,
          cycleNum: 1,
          workoutNum: 1,
          date: new Date(),
          lift: 'Squat',
          setNum: 1,
          weight: 135,
          reps: 5,
        },
      });
      await owner.trainingMax.create({
        data: { userId: uid, program: PROGRAM, lift: 'Squat', weight: 225, dateUpdated: new Date() },
      });
      await owner.trainingMaxHistory.create({
        data: {
          userId: uid,
          program: PROGRAM,
          lift: 'Squat',
          weight: 225,
          reps: 1,
          date: new Date(),
          isPR: false,
          source: 'program',
          goalMet: false,
        },
      });
      await owner.cycleScheduledWorkout.create({
        data: { userId: uid, program: PROGRAM, cycleNum: 1, workoutNum: 1, weekNum: 1, scheduledDate: new Date() },
      });
    };
    await seedAllTables(userId);
    await seedAllTables(otherUserId);

    const delRes = await inject({
      method: 'DELETE',
      url: `/programs/${PROGRAM}/cycles/current`,
      headers: { authorization: `Bearer ${userId}` },
    });
    expect(delRes.statusCode).toBe(204);

    const findAllFor = (uid: string) =>
      Promise.all([
        owner.cycleDashboard.findFirst({ where: { userId: uid, program: PROGRAM } }),
        owner.liftRecord.findFirst({ where: { userId: uid, program: PROGRAM } }),
        owner.trainingMax.findFirst({ where: { userId: uid, program: PROGRAM } }),
        owner.trainingMaxHistory.findFirst({ where: { userId: uid, program: PROGRAM } }),
        owner.cycleScheduledWorkout.findFirst({ where: { userId: uid, program: PROGRAM } }),
      ]);

    // The requesting user's rows are gone from every affected table...
    const mine = await findAllFor(userId);
    expect(mine).toEqual([null, null, null, null, null]);

    // ...but the other user's rows in every table survive — proves each of the
    // five deletes was RLS-scoped to the requesting user, not a bug that deleted
    // every row matching the program regardless of owner.
    const others = await findAllFor(otherUserId);
    for (const row of others) expect(row).not.toBeNull();

    await Promise.all([
      owner.cycleDashboard.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }),
      owner.liftRecord.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }),
      owner.trainingMax.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }),
      owner.trainingMaxHistory.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }),
      owner.cycleScheduledWorkout.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }),
    ]);
  });
});
