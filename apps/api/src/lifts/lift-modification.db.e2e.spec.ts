// Real-Postgres E2E suite for lift modifications (#1151). Postgres is provisioned by
// jest.global-setup.js. As in focus.db.e2e.spec.ts:
//   - `app` boots against the restricted lifting_app role, so every HTTP assertion below runs
//     through RlsInterceptor and forced row-level security, as production does;
//   - `prisma` is the owner connection, used only to clean up across synthetic users.
// The row-level-security policy itself is proven in rls.db.e2e.spec.ts.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { LiftRecord } from '@lifting-logbook/core';
import { LiftModificationResponse, LiftRecordResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { PrismaWorkoutRepository } from '../adapters/prisma/workout.repository';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { injectPage } from '../testing/macrocycle-id';

// See programs.db.e2e.spec.ts (#567): headroom for a contended full-suite Windows run.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_OWNER = 'db-e2e-modifications';
const USER_OTHER = 'db-e2e-modifications-other';
const USERS = [USER_OWNER, USER_OTHER];
const PROGRAM = 'db-e2e-modifications-program';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallbacks never run (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_DATABASE_URL ?? '';
const APP_DB_URL = APP_ROLE_URL ?? '';

async function cleanUsers(prisma: PrismaClient): Promise<void> {
  await prisma.liftModification.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.liftRecord.deleteMany({ where: { userId: { in: USERS } } });
}

describeOrSkip('Lift modifications HTTP (e2e, PrismaRepositoryFactory)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  const as = (user: string) => (method: string, url: string, body?: unknown) =>
    injectPage(app, {
      method: method as 'GET',
      url,
      headers:
        body === undefined
          ? { authorization: `Bearer ${user}` }
          : { 'content-type': 'application/json', authorization: `Bearer ${user}` },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const owner = as(USER_OWNER);
  const other = as(USER_OTHER);

  const set = (overrides: Record<string, unknown> = {}) => ({
    macrocycleNum: 1,
    workoutNum: 1,
    date: '2026-04-20',
    lift: 'Bench Press',
    setNum: 1,
    weight: 180,
    reps: 5,
    ...overrides,
  });

  async function create(lift: string, name: string, maxMode = 'none'): Promise<LiftModificationResponse> {
    const res = await owner('POST', '/lifts/modifications', { lift, name, maxMode });
    expect(res.statusCode).toBe(201);
    return res.json() as LiftModificationResponse;
  }

  beforeAll(async () => {
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
    prisma = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanUsers(prisma);
    // Sets can only be logged to a macrocycle the program has (ADR-042).
    await prisma.macrocycle.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.macrocycle.createMany({
      data: USERS.map((userId) => ({
        userId,
        program: PROGRAM,
        macrocycleNum: 1,
        startDate: new Date('2026-04-20T00:00:00.000Z'),
        status: 'in-progress',
        origin: 'live',
      })),
    });

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await cleanUsers(prisma).catch(() => undefined);
    await prisma?.macrocycle.deleteMany({ where: { userId: { in: USERS } } }).catch(() => undefined);
    await prisma?.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanUsers(prisma);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('creates two on one lift, lists them, renames one, and answers 409 on a duplicate name', async () => {
    const wide = await create('Cable Curl', 'Wide grip', 'own');
    const noChalk = await create('Cable Curl', 'No chalk');
    expect(wide).toMatchObject({ lift: 'cable-curl', maxMode: 'own', description: '' });

    const listed = (await owner('GET', '/lifts/modifications')).json() as LiftModificationResponse[];
    expect(listed.map((m) => m.id)).toEqual([noChalk.id, wide.id]);

    const renamed = await owner('PATCH', `/lifts/modifications/${noChalk.id}`, { name: 'Straps' });
    expect(renamed.json()).toMatchObject({ id: noChalk.id, name: 'Straps' });

    expect((await owner('POST', '/lifts/modifications', { lift: 'Cable Curl', name: 'Straps' })).statusCode).toBe(409);
    expect((await owner('PATCH', `/lifts/modifications/${wide.id}`, { name: 'Straps' })).statusCode).toBe(409);
  });

  it("keeps a user from reading, editing or attaching another user's modification", async () => {
    const paused = await create('Bench Press', 'Paused');

    expect((await other('GET', '/lifts/modifications')).json()).toEqual([]);
    expect((await other('PATCH', `/lifts/modifications/${paused.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await other('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(404);
    const logged = await other('POST', `/programs/${PROGRAM}/lift-records`, set({ modifications: [paused.id] }));
    expect(logged.statusCode).toBe(400);
    expect(await prisma.liftRecord.count({ where: { userId: USER_OTHER } })).toBe(0);
  });

  it('stores the ids on the row, on a lift spelled differently, and PATCH replaces them', async () => {
    const paused = await create('Bench Press', 'Paused');
    const noChalk = await create('Bench Press', 'No chalk');
    const res = await owner(
      'POST',
      `/programs/${PROGRAM}/lift-records`,
      set({ lift: 'bench-press', modifications: [paused.id] }),
    );
    expect(res.statusCode).toBe(201);
    const record = res.json() as LiftRecordResponse;
    expect(record.modifications).toEqual([{ id: paused.id, name: 'Paused' }]);
    const stored = () => prisma.liftRecord.findFirstOrThrow({ where: { userId: USER_OWNER } });
    expect((await stored()).modifications).toEqual([paused.id]);

    const url = `/programs/${PROGRAM}/lift-records/${encodeURIComponent(record.id)}`;
    const replaced = await owner('PATCH', url, { modifications: [noChalk.id] });
    expect(replaced.statusCode).toBe(200);
    expect((await stored()).modifications).toEqual([noChalk.id]);

    const cleared = await owner('PATCH', url, { modifications: [] });
    expect(cleared.json()).not.toHaveProperty('modifications');
    expect((await stored()).modifications).toEqual([]);
  });

  it('rejects two `own` modifications on one set', async () => {
    const wide = await create('Cable Curl', 'Wide grip', 'own');
    const narrow = await create('Cable Curl', 'Narrow grip', 'own');
    const res = await owner(
      'POST',
      `/programs/${PROGRAM}/lift-records`,
      set({ lift: 'Cable Curl', modifications: [wide.id, narrow.id] }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('removes an unused modification, and archives one a set names', async () => {
    const unused = await create('Bench Press', 'Unused');
    const paused = await create('Bench Press', 'Paused');
    const logged = await owner('POST', `/programs/${PROGRAM}/lift-records`, set({ modifications: [paused.id] }));
    const { id } = logged.json() as LiftRecordResponse;

    expect((await owner('DELETE', `/lifts/modifications/${unused.id}`)).statusCode).toBe(204);
    expect(await prisma.liftModification.findUnique({ where: { id: unused.id } })).toBeNull();

    expect((await owner('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(204);
    const row = await prisma.liftModification.findUniqueOrThrow({ where: { id: paused.id } });
    expect(row.archivedAt).not.toBeNull();
    expect((await owner('GET', '/lifts/modifications')).json()).toEqual([]);

    const edited = await owner('PATCH', `/programs/${PROGRAM}/lift-records/${encodeURIComponent(id)}`, { reps: 6 });
    expect((edited.json() as LiftRecordResponse).modifications).toEqual([{ id: paused.id, name: 'Paused' }]);

    // Creating the name again brings the same row back, so old sets and new ones share an id.
    const restored = await create('Bench Press', 'Paused');
    expect(restored.id).toBe(paused.id);
    expect((await prisma.liftModification.findUniqueOrThrow({ where: { id: paused.id } })).archivedAt).toBeNull();
  });

  it("another user's sets naming the same id don't keep a modification from deleting", async () => {
    const paused = await create('Bench Press', 'Paused');
    await prisma.liftRecord.create({
      data: {
        userId: USER_OTHER,
        program: PROGRAM,
        macrocycleNum: 1,
        workoutNum: 1,
        date: new Date('2026-04-20'),
        lift: 'bench-press',
        setNum: 1,
        weight: 180,
        reps: 5,
        modifications: [paused.id],
      },
    });
    expect((await owner('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(204);
    expect(await prisma.liftModification.findUnique({ where: { id: paused.id } })).toBeNull();
  });

  it('saveWorkout keeps its sets\' modifications, under the restricted role', async () => {
    const paused = await create('Bench Press', 'Paused');
    const record: LiftRecord = {
      program: PROGRAM,
      macrocycleNum: 1,
      workoutNum: 1,
      date: new Date('2026-04-20T00:00:00.000Z'),
      lift: 'bench-press',
      setNum: 1,
      weight: 180,
      reps: 5,
      notes: '',
      modifications: [paused.id],
    };
    const unmodified: LiftRecord = { ...record, setNum: 2, modifications: [] };
    const appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
    try {
      const saved = await appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${USER_OWNER}, true)`;
        const repo = new PrismaWorkoutRepository(tx as unknown as PrismaClient, USER_OWNER);
        await repo.saveWorkout(PROGRAM, 1, 1, [record, unmodified]);
        return repo.getWorkout(PROGRAM, 1, 1);
      });
      expect(saved.map((r) => r.modifications)).toEqual([[paused.id], undefined]);
    } finally {
      await appDb.$disconnect();
    }
  });

  it('the CHECK constraint refuses an unknown maxMode', async () => {
    await expect(
      prisma.liftModification.create({
        data: { userId: USER_OWNER, lift: 'bench-press', name: 'Bad', maxMode: 'other' },
      }),
    ).rejects.toThrow();
  });
});
