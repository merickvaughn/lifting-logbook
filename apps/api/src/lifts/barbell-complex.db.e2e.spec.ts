// Real-Postgres E2E suite for barbell complex definitions (#1495). Postgres is provisioned by
// jest.global-setup.js. As in lift-modification.db.e2e.spec.ts:
//   - `app` boots against the restricted lifting_app role, so every HTTP assertion below runs
//     through RlsInterceptor and forced row-level security, as production does;
//   - `prisma` is the owner connection, used only to clean up across synthetic users.
// The row-level-security policy itself is proven in rls.db.e2e.spec.ts.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { complexLift } from '@lifting-logbook/core';
import { BarbellComplexResponse, WorkoutResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { injectPage } from '../testing/macrocycle-id';

// See programs.db.e2e.spec.ts (#567): headroom for a contended full-suite Windows run.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_OWNER = 'db-e2e-complexes';
const USER_OTHER = 'db-e2e-complexes-other';
const USERS = [USER_OWNER, USER_OTHER];

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallbacks never run (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_DATABASE_URL ?? '';

const BEAR = [
  { lift: 'Deadlift', reps: 5 },
  { lift: 'Front Squat', reps: 5 },
  { lift: 'Push Press', reps: 5 },
];

const SPEC_ROW = {
  week: 1,
  offset: 0,
  increment: 5,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0.1,
  activation: 'none',
};

async function cleanUsers(prisma: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await prisma.barbellComplex.deleteMany({ where });
  // Specs cascade from their program.
  await prisma.customProgram.deleteMany({ where });
  await prisma.macrocycle.deleteMany({ where });
  await prisma.macrocycleDashboard.deleteMany({ where });
  await prisma.userSettings.deleteMany({ where });
}

describeOrSkip('Barbell complexes HTTP (e2e, PrismaRepositoryFactory, #1495)', () => {
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

  async function create(name: string, request = owner): Promise<BarbellComplexResponse> {
    const res = await request('POST', '/lifts/complexes', { name, components: BEAR });
    expect(res.statusCode).toBe(201);
    return res.json() as BarbellComplexResponse;
  }

  beforeAll(async () => {
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
    prisma = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanUsers(prisma);

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await cleanUsers(prisma).catch(() => undefined);
    await prisma?.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanUsers(prisma);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('creates, lists, updates and deletes a complex as the restricted role', async () => {
    const created = await create('Bear');
    const stored = await prisma.barbellComplex.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored).toMatchObject({ userId: USER_OWNER, name: 'Bear', components: BEAR });

    expect((await owner('GET', '/lifts/complexes')).json()).toEqual([created]);

    const components = [BEAR[1], BEAR[0]];
    const updated = await owner('PATCH', `/lifts/complexes/${created.id}`, { name: 'Small bear', components });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: created.id, name: 'Small bear', components });

    expect((await owner('DELETE', `/lifts/complexes/${created.id}`)).statusCode).toBe(204);
    expect(await prisma.barbellComplex.count({ where: { userId: USER_OWNER } })).toBe(0);
  });

  it('answers 409 on a taken name and 404 on an unknown id', async () => {
    await create('Bear');
    const second = await create('Clean complex');
    expect((await owner('POST', '/lifts/complexes', { name: 'Bear', components: BEAR })).statusCode).toBe(409);
    expect((await owner('PATCH', `/lifts/complexes/${second.id}`, { name: 'Bear' })).statusCode).toBe(409);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await owner('PATCH', `/lifts/complexes/${unknown}`, { name: 'Bear 2' })).statusCode).toBe(404);
    expect((await owner('DELETE', `/lifts/complexes/${unknown}`)).statusCode).toBe(404);
  });

  it("neither lists nor changes another user's complex, and lets both users use one name", async () => {
    const mine = await create('Bear');
    expect((await other('GET', '/lifts/complexes')).json()).toEqual([]);
    expect((await other('PATCH', `/lifts/complexes/${mine.id}`, { name: 'Taken' })).statusCode).toBe(404);
    expect((await other('DELETE', `/lifts/complexes/${mine.id}`)).statusCode).toBe(404);
    await create('Bear', other);
    expect(await prisma.barbellComplex.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ name: 'Bear' });
  });

  it('accepts a program row that names a complex, and lists it among the workout lifts', async () => {
    const bear = await create('Bear');
    const program = await owner('POST', '/programs/custom', {
      name: 'Complex day',
      specs: [
        { ...SPEC_ROW, lift: 'Bench Press', order: 1 },
        { ...SPEC_ROW, lift: complexLift(bear.id), order: 2 },
      ],
    });
    expect(program.statusCode).toBe(201);
    const { id } = program.json() as { id: string };

    expect((await owner('POST', `/programs/${id}/macrocycles/initialize`, {})).statusCode).toBeLessThan(300);
    const workout = await owner('GET', `/programs/${id}/workouts/1`);
    expect(workout.statusCode).toBe(200);
    expect((workout.json() as WorkoutResponse).lifts.map((l) => l.lift)).toEqual(['Bench Press', complexLift(bear.id)]);
  });
});
