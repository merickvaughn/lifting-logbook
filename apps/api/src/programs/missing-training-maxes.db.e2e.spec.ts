// Real-Postgres E2E suite for the missing-training-max list (#1246, #1269).
//
// Postgres comes from jest.global-setup.js, which exposes LIFTING_TC_DATABASE_URL (the
// restricted lifting_app role) and LIFTING_TC_OWNER_DATABASE_URL (the owner). Seeding and cleanup
// use the owner; every request runs as lifting_app, so row-level security is what keeps one
// user's sets out of another's list.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { MissingTrainingMaxResponse } from '@lifting-logbook/types';
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

const PROGRAM = '5-3-1';
const USER_ALICE = 'missing-max-db-alice';
const USER_BOB = 'missing-max-db-bob';
const USERS = [USER_ALICE, USER_BOB];

async function cleanup(owner: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await owner.liftRecord.deleteMany({ where });
  await owner.trainingMax.deleteMany({ where });
}

describeOrSkip('missing training maxes (full app, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const set = (userId: string, lift: string, setNum: number, weight: number, reps: number, date = '2026-11-03') => ({
    userId,
    program: PROGRAM,
    macrocycleNum: 1,
    workoutNum: 1,
    date: day(date),
    lift,
    setNum,
    weight,
    reps,
    notes: '',
  });

  const getAs = async (user: string, query = '') => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: `/programs/${PROGRAM}/training-maxes/missing${query}`,
      headers: { authorization: `Bearer ${user}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<MissingTrainingMaxResponse[]>();
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanup(owner);
    await owner.trainingMax.create({
      data: { userId: USER_ALICE, program: PROGRAM, lift: 'Squat', weight: 300, dateUpdated: day('2026-10-01') },
    });
    await owner.liftRecord.createMany({
      data: [
        set(USER_ALICE, 'Romanian Deadlift', 1, 100, 5),
        set(USER_ALICE, 'Romanian Deadlift', 2, 90, 5),
        set(USER_ALICE, 'Squat', 1, 315, 3),
        // Bob's lift, which Alice's list must never show.
        set(USER_BOB, 'Cable Curl', 1, 40, 10),
      ],
    });
    process.env.DATABASE_URL = APP_DB_URL;
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await cleanup(owner);
    await owner.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it("lists the user's own lift with no max, with its estimate", async () => {
    const missing = await getAs(USER_ALICE);

    expect(missing).toEqual([
      {
        lift: 'Romanian Deadlift',
        liftId: 'romanian-deadlift',
        lastLoggedDate: '2026-11-03',
        setCount: 2,
        estimate: { weight: 100, unit: 'lbs', from: { date: '2026-11-03', weight: 100, reps: 5 } },
        dismissed: false,
      },
    ]);
  });

  it("never shows another user's lift", async () => {
    expect((await getAs(USER_BOB)).map((m) => m.lift)).toEqual(['Cable Curl']);
    expect((await getAs(USER_ALICE, '?lifts=Cable%20Curl'))).toEqual([]);
  });
});
