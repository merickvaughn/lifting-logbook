// Real-Postgres E2E for importing a one-week program spec, which has no Week column (#1312).
// Postgres comes from jest.global-setup.js. Seeding and cleanup use the owner; requests run as
// lifting_app under row-level security.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import multipart from '@fastify/multipart';
import type { CustomProgramResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainNotFoundFilter } from './not-found.filter';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_TC_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_TC_URL ? describe : describe.skip;
const OWNER_URL = OWNER_TC_URL ?? '';
const APP_DB_URL = APP_ROLE_URL ?? '';

// See #567: full-suite Windows runs can push a seeding hook past Jest's 5s default.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;
jest.setTimeout(DB_E2E_HOOK_TIMEOUT_MS);

const USER = 'import-spec-no-week-db';

// The 2026 RPT header: no Week column, and an Offset -1 row.
const SPEC_2026 = [
  'Offset,Lift,Increment,Order,Sets,Reps,AMRAP?,Warm-Up %,WT Decrement %,Activation',
  '-1,Squat,5,1,3,8,FALSE,.6,0.05,Glute Bridge',
  '0,Bench P.,2.5,1,3,8,TRUE,.6,0.05,Band Flye',
].join('\n');

describeOrSkip('program-spec import without a Week column (#1312, e2e, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await owner.customProgram.deleteMany({ where: { userId: USER } });
    process.env.DATABASE_URL = APP_DB_URL;
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await owner?.customProgram.deleteMany({ where: { userId: USER } }).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('stores every row in week 1, keeping the Offset -1 row', async () => {
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: `Bearer ${USER}` };
    const created = await server.inject({
      method: 'POST',
      url: '/custom-programs',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'No-week import',
        specs: [
          { week: 1, offset: 0, lift: 'Deadlift', increment: 5, order: 1, sets: 3, reps: 5, amrap: false, warmUpPct: '.6', wtDecrementPct: 0.05, activation: 'x' },
        ],
      }),
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<CustomProgramResponse>();

    const boundary = '----NoWeekBoundary';
    const res = await server.inject({
      method: 'POST',
      url: `/programs/${id}/import?mode=commit&destination=program-spec`,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="upload.csv"',
        'Content-Type: text/csv',
        '',
        SPEC_2026,
        `--${boundary}--`,
      ].join('\r\n'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ destination: 'program-spec', created: 2 });

    const read = await server.inject({ method: 'GET', url: `/custom-programs/${id}`, headers });
    const squat = read.json<CustomProgramResponse>().specs.find((s) => s.lift === 'Squat');
    expect(squat).toMatchObject({ week: 1, offset: -1 });
    expect(read.json<CustomProgramResponse>().specs.find((s) => s.lift === 'Bench P.')).toMatchObject({ week: 1, offset: 0 });
  });
});
