// Real-Postgres E2E for the custom-program week type (#1187): a value outside WeekType is
// refused on write, a valid or omitted one is accepted, and a row already stored with another
// value still reads back through GET. Postgres comes from jest.global-setup.js; seeding and
// cleanup use the owner, requests run as lifting_app.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_TC_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_TC_URL ? describe : describe.skip;
const OWNER_URL = OWNER_TC_URL ?? '';
const APP_DB_URL = APP_ROLE_URL ?? '';

// See #567: full-suite Windows runs can push a seeding hook past Jest's 5s default.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;
jest.setTimeout(DB_E2E_HOOK_TIMEOUT_MS);

const USER = 'custom-programs-week-type-db';

const SPEC_ROW = {
  week: 1,
  offset: 0,
  lift: 'Bench Press',
  increment: 5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0.1,
  activation: 'none',
};

describeOrSkip('Custom program weekType (#1187, DB e2e)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await owner.customProgram.deleteMany({ where: { userId: USER } });
    process.env.DATABASE_URL = APP_DB_URL;
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await owner?.customProgram.deleteMany({ where: { userId: USER } }).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  const server = () => app.getHttpAdapter().getInstance();
  const post = (name: string, row: Record<string, unknown>) =>
    server().inject({
      method: 'POST',
      url: '/programs/custom',
      headers: { authorization: `Bearer ${USER}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name, specs: [{ ...SPEC_ROW, ...row }] }),
    });

  it('returns 400 for a weekType outside WeekType', async () => {
    const res = await post('bad week type', { weekType: '=HYPERLINK("x")' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string[] }).message).toEqual([
      'specs.0.weekType must be one of the following values: training, test, deload',
    ]);
    expect(await owner.customProgram.count({ where: { userId: USER, name: 'bad week type' } })).toBe(0);
  });

  it.each(['training', 'test', 'deload'])('accepts weekType %s', async (weekType) => {
    const res = await post(`week type ${weekType}`, { weekType });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { specs: Array<{ weekType?: string }> }).specs[0]?.weekType).toBe(weekType);
  });

  it('accepts an omitted weekType', async () => {
    const res = await post('no week type', {});
    expect(res.statusCode).toBe(201);
  });

  it('still reads back a stored row whose weekType is outside WeekType', async () => {
    const program = await owner.customProgram.create({
      data: { userId: USER, name: 'legacy', specs: { create: [{ ...SPEC_ROW, weekType: 'legacy-value' }] } },
    });
    const res = await server().inject({
      method: 'GET',
      url: `/programs/custom/${program.id}`,
      headers: { authorization: `Bearer ${USER}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { specs: Array<{ weekType?: string }> }).specs[0]?.weekType).toBe('legacy-value');
  });
});
