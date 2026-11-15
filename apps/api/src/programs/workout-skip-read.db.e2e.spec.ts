// Real-Postgres E2E suite for a failed skip read on `GET /workouts/:n` (#1288).
//
// The request runs inside one RLS transaction (rls.interceptor.ts), and a failed statement aborts
// it (SQLSTATE 25P02). So the skip read's error can't be caught and carried past, and the
// controller no longer tries. This suite makes the skip query itself fail in the database and
// checks that the request fails with that query's own Postgres error, not an aborted-transaction
// one. A mocked rejection (workouts.controller.spec.ts) can't see the transaction.
//
// Prisma sends the reads the controller starts in one tick as one batch inside the transaction, and
// a failed batch rejects every read in it with the same error, so the error a request fails with
// names the first read in the batch, not the skip read. The Postgres error inside it is the skip
// query's. Before #1288 the controller logged that it was carrying on with no skips while the
// request failed anyway.
//
// The failure is a restrictive RLS policy on `workout_skip_override` that raises for one test
// user's rows only, so DB suites running alongside this one read their skips as usual. Seeding,
// the policy and cleanup use the owner; every request runs as lifting_app.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
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
const USER = 'skip-read-db-alice';
const FAILURE = 'skip read failed (#1288 test)';
const POLICY = 'test_1288_skip_read_fails';
const FUNCTION = 'test_1288_fail_skip_read';

async function cleanup(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS "${POLICY}" ON "workout_skip_override"`);
  await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FUNCTION}()`);
  await owner.workoutSkipOverride.deleteMany({ where: { userId: USER } });
}

describeOrSkip('a failed skip read on a workout (full app, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanup(owner);
    // The policy's expression runs once per row, so the user needs a row for the query to fail.
    await owner.workoutSkipOverride.create({
      data: { userId: USER, program: PROGRAM, macrocycleNum: 1, workoutNum: 2 },
    });
    await owner.$executeRawUnsafe(
      `CREATE FUNCTION ${FUNCTION}() RETURNS boolean LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION '${FAILURE}'; END $$`,
    );
    await owner.$executeRawUnsafe(
      `CREATE POLICY "${POLICY}" ON "workout_skip_override" AS RESTRICTIVE FOR SELECT
       USING ("userId" <> '${USER}' OR ${FUNCTION}())`,
    );
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

  it("fails the request with the skip query's own error, not a later query's", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${PROGRAM}/workouts/1`,
        headers: { authorization: `Bearer ${USER}` },
      });

      expect(res.statusCode).toBe(500);
      // Nest's ExceptionsHandler logs the error the request failed with.
      const logged = errorSpy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
      expect(logged.some((line) => line.includes(FAILURE))).toBe(true);
      expect(logged.some((line) => line.includes('current transaction is aborted'))).toBe(false);
      // The skip read was caught and logged as read with no skips before #1288.
      expect(logged.some((line) => line.includes('defaulting to empty set'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
