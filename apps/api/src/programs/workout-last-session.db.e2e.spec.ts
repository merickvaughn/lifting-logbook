// Real-Postgres E2E suite for each lift's last session on `GET /workouts/:n` (#1252): the grouped
// query and the set query `PrismaLiftRecordRepository.getLastSessions` makes.
//
// Postgres comes from jest.global-setup.js, which exposes LIFTING_TC_DATABASE_URL (the
// restricted lifting_app role) and LIFTING_TC_OWNER_DATABASE_URL (the owner). Seeding and cleanup
// use the owner; every request runs as lifting_app, so row-level security is what keeps another
// user's later session out of this user's plan.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { WorkoutResponse } from '@lifting-logbook/types';
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
const USER_ALICE = 'last-session-db-alice';
const USER_BOB = 'last-session-db-bob';
const USERS = [USER_ALICE, USER_BOB];

async function cleanup(owner: PrismaClient): Promise<void> {
  await owner.liftRecord.deleteMany({ where: { userId: { in: USERS } } });
}

describeOrSkip('a workout lift’s last session (full app, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const sets = (userId: string, workoutNum: number, date: string, lift: string, reps: number[], occurrence = 0) =>
    reps.map((r, i) => ({
      userId,
      program: PROGRAM,
      macrocycleNum: 1,
      workoutNum,
      date: day(date),
      lift,
      occurrence,
      setNum: i + 1,
      weight: 30,
      reps: r,
      notes: '',
    }));

  const getAs = async (user: string, workoutNum: number) => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: `/programs/${PROGRAM}/workouts/${workoutNum}`,
      headers: { authorization: `Bearer ${user}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<WorkoutResponse>();
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanup(owner);
    await owner.liftRecord.createMany({
      data: [
        ...sets(USER_ALICE, 1, '2026-11-02', 'Cable Curl', [12, 12, 12]),
        // The later session, stored by catalog id.
        ...sets(USER_ALICE, 2, '2026-11-04', 'cable-curl', [12, 11, 10]),
        // A second occurrence of the lift in that workout, which doesn't count.
        ...sets(USER_ALICE, 2, '2026-11-04', 'Cable Curl', [6], 1),
        // A workout dated after this one, which doesn't count either.
        ...sets(USER_ALICE, 5, '2026-11-09', 'Cable Curl', [8, 8, 8]),
        // This workout's own set.
        ...sets(USER_ALICE, 3, '2026-11-06', 'Cable Curl', [9]),
        // Bob's own workout 3, whose last session is his workout 2, dated before Alice's latest:
        // reading any of her sets would give him hers.
        ...sets(USER_BOB, 2, '2026-11-03', 'Cable Curl', [7, 7]),
        ...sets(USER_BOB, 3, '2026-11-06', 'Cable Curl', [9]),
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

  it('gives the later of two earlier workouts’ reps, under another spelling, leaving out this workout and a second occurrence', async () => {
    const workout = await getAs(USER_ALICE, 3);

    const curl = workout.lifts.find((l) => l.lift === 'Cable Curl');
    expect(curl?.lastSession).toEqual({ date: '2026-11-04', reps: [12, 11, 10] });
  });

  it("never reads another user's session", async () => {
    const workout = await getAs(USER_BOB, 3);

    const curl = workout.lifts.find((l) => l.lift === 'Cable Curl');
    expect(curl?.lastSession).toEqual({ date: '2026-11-03', reps: [7, 7] });
  });
});
