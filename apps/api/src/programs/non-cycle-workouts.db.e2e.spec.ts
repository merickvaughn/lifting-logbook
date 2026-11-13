// Real-Postgres E2E suite for non-cycle workouts (proposal 2026-11-06, decision 23, #1184).
//
// Postgres comes from jest.global-setup.js, which exposes LIFTING_TC_DATABASE_URL (the
// restricted lifting_app role) and LIFTING_TC_OWNER_DATABASE_URL (the owner). Cleanup uses the
// owner; every request and every isolation assertion runs as lifting_app, so row-level security
// is what keeps one user's non-cycle workouts from another.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { LiftRecordResponse, MACROCYCLE_ID_HEADER, NON_CYCLE_PROGRAM, NonCycleWorkoutResponse } from '@lifting-logbook/types';
import multipart from '@fastify/multipart';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_TC_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_TC_URL ? describe : describe.skip;
// Only read inside the guarded describe block, where both are set.
const OWNER_URL = OWNER_TC_URL ?? '';
const APP_DB_URL = APP_ROLE_URL ?? '';

// See #567: full-suite Windows runs can push a seeding hook past Jest's 5s default.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_ALICE = 'non-cycle-db-alice';
const USER_BOB = 'non-cycle-db-bob';
const USER_CAROL = 'non-cycle-db-carol';
const USERS = [USER_ALICE, USER_BOB, USER_CAROL];

async function asUser<T>(client: PrismaClient, userId: string | null, body: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return client.$transaction(async (tx) => {
    if (userId !== null) await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    return body(tx as unknown as PrismaClient);
  });
}

async function cleanup(owner: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await owner.liftRecord.deleteMany({ where });
  await owner.macrocycle.deleteMany({ where });
  await owner.importBatch.deleteMany({ where });
}

describeOrSkip('non-cycle workouts (full app, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let appDb: PrismaClient;
  let alice: NonCycleWorkoutResponse;

  const today = new Date().toISOString().slice(0, 10);
  const setBody = { date: today, lift: 'Squat', setNum: 1, weight: 225, reps: 5 };

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

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
    await cleanup(owner);
    process.env.DATABASE_URL = APP_DB_URL;
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const res = await injectAs(USER_ALICE, 'POST', '/non-cycle-workouts', setBody);
    expect(res.statusCode).toBe(201);
    alice = res.json() as NonCycleWorkoutResponse;
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup(owner).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await appDb?.$disconnect().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('the app-role connection does not bypass RLS', async () => {
    const rows = await appDb.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('stores the set and the non-cycle macrocycle row as the caller’s, readable by no one else', async () => {
    const records = await asUser(appDb, USER_ALICE, (tx) =>
      tx.liftRecord.findMany({ where: { program: NON_CYCLE_PROGRAM, userId: { in: USERS } } }),
    );
    expect(records.map((r) => r.userId)).toEqual([USER_ALICE]);
    const rows = await asUser(appDb, USER_ALICE, (tx) =>
      tx.macrocycle.findMany({ where: { program: NON_CYCLE_PROGRAM, userId: { in: USERS } } }),
    );
    expect(rows).toEqual([expect.objectContaining({ id: alice.macrocycleId, userId: USER_ALICE, origin: 'non-cycle', status: 'unknown' })]);

    const asBob = await asUser(appDb, USER_BOB, (tx) =>
      Promise.all([
        tx.liftRecord.count({ where: { program: NON_CYCLE_PROGRAM, userId: USER_ALICE } }),
        tx.macrocycle.count({ where: { program: NON_CYCLE_PROGRAM, userId: USER_ALICE } }),
      ]),
    );
    expect(asBob).toEqual([0, 0]);
    expect(await asUser(appDb, null, (tx) => tx.liftRecord.count({ where: { program: NON_CYCLE_PROGRAM } }))).toBe(0);
  });

  it('shows another user nothing, and lets them change nothing', async () => {
    expect((await injectAs(USER_BOB, 'GET', '/non-cycle-workouts')).json()).toEqual([]);
    expect((await injectAs(USER_BOB, 'GET', `/non-cycle-workouts/${alice.workoutNum}`)).statusCode).toBe(404);
    expect((await injectAs(USER_BOB, 'DELETE', `/non-cycle-workouts/${alice.workoutNum}`, undefined, alice.macrocycleId)).statusCode).toBe(404);
    const setId = alice.records[0]?.id ?? '';
    const edit = await injectAs(USER_BOB, 'PATCH', `/programs/${NON_CYCLE_PROGRAM}/lift-records/${encodeURIComponent(setId)}`, { reps: 1 }, alice.macrocycleId);
    expect(edit.statusCode).toBe(404);
    const add = await injectAs(USER_BOB, 'POST', `/programs/${NON_CYCLE_PROGRAM}/lift-records`, {
      ...setBody, macrocycleNum: 1, workoutNum: alice.workoutNum, setNum: 2,
    }, alice.macrocycleId);
    expect(add.statusCode).toBe(404);

    const list = (await injectAs(USER_ALICE, 'GET', '/non-cycle-workouts')).json() as LiftRecordResponse[];
    expect(list).toEqual(alice.records);
  });

  it('leaves the reserved id out of the custom program list', async () => {
    // The built-in half of the program list is reserved-program.registry.spec.ts.
    const res = await injectAs(USER_ALICE, 'GET', '/programs/custom');
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ id: string }>).map((p) => p.id)).not.toContain(NON_CYCLE_PROGRAM);
  });

  it('keeps a set recorded under a deleted workout’s number when the import that made it is undone', async () => {
    const boundary = '----NonCycleDbBoundary';
    const csv = [
      'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
      '5-3-1,1,1,2026-01-05,Squat,1,225,5,',
      'non-cycle,1,9,2026-01-06,Squat,1,315,1,',
    ].join('\n');
    const commit = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/programs/5-3-1/import?mode=commit&destination=lift-records',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${USER_CAROL}` },
      payload: [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="upload.csv"', 'Content-Type: text/csv', '', csv, `--${boundary}--`].join('\r\n'),
    });
    expect(commit.json()).toMatchObject({ created: 2 });
    const imported = (await injectAs(USER_CAROL, 'GET', '/non-cycle-workouts/1')).json() as NonCycleWorkoutResponse;
    expect((await injectAs(USER_CAROL, 'DELETE', '/non-cycle-workouts/1', undefined, imported.macrocycleId)).statusCode).toBe(204);

    const redone = (await injectAs(USER_CAROL, 'POST', '/non-cycle-workouts', { date: '2026-01-06', lift: 'Squat', setNum: 1, weight: 300, reps: 2 })).json() as NonCycleWorkoutResponse;
    expect(redone.workoutNum).toBe(1);
    const undo = await injectAs(USER_CAROL, 'POST', `/programs/5-3-1/import/${(commit.json() as { batchId: string }).batchId}/undo`);
    expect(undo.json()).toMatchObject({ restored: 1, skipped: 0 });
    expect((await injectAs(USER_CAROL, 'GET', '/non-cycle-workouts')).json()).toEqual(redone.records);
  });

  it('numbers two workouts started at once apart', async () => {
    const [first, second] = await Promise.all([
      injectAs(USER_ALICE, 'POST', '/non-cycle-workouts', setBody),
      injectAs(USER_ALICE, 'POST', '/non-cycle-workouts', setBody),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    const nums = [first, second].map((res) => (res.json() as NonCycleWorkoutResponse).workoutNum).sort((a, b) => a - b);
    expect(nums).toEqual([alice.workoutNum + 1, alice.workoutNum + 2]);
  });
});
