// Real-Postgres E2E suite for a failed undo-batch save on an import commit (#1288).
//
// The commit runs inside one RLS transaction (rls.interceptor.ts), and a failed statement aborts it.
// Before #1288 the commit caught a failed batch save and returned success with `batchId: null`,
// but the aborted transaction then rolled back every row the response reported. The commit now
// fails instead, so a lifter is never told rows were imported that weren't.
//
// The failure is a restrictive RLS policy on `import_batch` that raises on one test user's
// inserts only, so DB suites running alongside this one save their batches as usual. Seeding, the
// policy and cleanup use the owner; every request runs as lifting_app.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
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

const PROGRAM = '5-3-1';
const USER = 'batch-save-db-alice';
const FAILURE = 'batch save failed (#1288 test)';
const POLICY = 'test_1288_batch_save_fails';
const FUNCTION = 'test_1288_fail_batch_save';

const LIFT_CSV = [
  'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
  '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,',
].join('\n');

async function cleanup(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS "${POLICY}" ON "import_batch"`);
  await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FUNCTION}()`);
  const where = { userId: USER };
  await owner.liftRecord.deleteMany({ where });
  await owner.macrocycle.deleteMany({ where });
  await owner.importBatch.deleteMany({ where });
}

describeOrSkip('a failed undo-batch save on an import commit (full app, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  const commit = () => {
    const boundary = '----BatchSaveBoundary';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="upload.csv"',
      'Content-Type: text/csv',
      '',
      LIFT_CSV,
      `--${boundary}--`,
    ].join('\r\n');
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/programs/${PROGRAM}/import?mode=commit&destination=lift-records`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${USER}` },
      payload,
    });
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanup(owner);
    await owner.$executeRawUnsafe(
      `CREATE FUNCTION ${FUNCTION}() RETURNS boolean LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION '${FAILURE}'; END $$`,
    );
    await owner.$executeRawUnsafe(
      `CREATE POLICY "${POLICY}" ON "import_batch" AS RESTRICTIVE FOR INSERT
       WITH CHECK ("userId" <> '${USER}' OR ${FUNCTION}())`,
    );
    process.env.DATABASE_URL = APP_DB_URL;
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
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

  it('fails the commit with the save’s own error, and writes nothing', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await commit();

      // The transaction rolled back, before #1288 too.
      expect(await owner.liftRecord.count({ where: { userId: USER } })).toBe(0);
      // Before #1288: a 200 reporting the row created, with no batch.
      expect({ status: res.statusCode, body: res.statusCode === 200 ? res.json() : undefined }).toEqual({ status: 500, body: undefined });
      const logged = errorSpy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
      expect(logged.some((line) => line.includes(FAILURE))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
