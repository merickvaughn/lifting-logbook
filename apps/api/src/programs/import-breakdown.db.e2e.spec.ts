// Real-Postgres E2E suite for an import through the Assign step (#1254): the criteria that need a
// real transaction, a real advisory lock or real row counts.
//
// Postgres comes from jest.global-setup.js, which exposes LIFTING_TC_DATABASE_URL (the
// restricted lifting_app role) and LIFTING_TC_OWNER_DATABASE_URL (the owner). Seeding, cleanup
// and the row counts use the owner; every request runs as lifting_app.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import multipart from '@fastify/multipart';
import type { ImportBreakdown } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { PrismaImportBatchRepository } from '../adapters/prisma/import-batch.repository';
import { PrismaLiftRecordRepository } from '../adapters/prisma/lift-record.repository';
import { PrismaMacrocycleRepository } from '../adapters/prisma/macrocycle.repository';
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
// The row-limit test seeds 20,000 rows before a commit that may take up to the 30-second import transaction.
const ROW_LIMIT_TEST_TIMEOUT_MS = 120_000;

const USER_RACE = 'import-breakdown-db-race';
const USER_MACROCYCLE_FAILS = 'import-breakdown-db-macrocycle-fails';
const USER_BATCH_FAILS = 'import-breakdown-db-batch-fails';
const USER_ROW_LIMIT = 'import-breakdown-db-row-limit';
const USERS = [USER_RACE, USER_MACROCYCLE_FAILS, USER_BATCH_FAILS, USER_ROW_LIMIT];

async function cleanup(owner: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await owner.liftRecord.deleteMany({ where });
  await owner.macrocycle.deleteMany({ where });
  await owner.importBatch.deleteMany({ where });
  await owner.trainingMax.deleteMany({ where });
  await owner.macrocycleDashboard.deleteMany({ where });
}

const DAY_MS = 86_400_000;
const ymd = (date: Date) => date.toISOString().slice(0, 10);
const dayFrom = (start: string, n: number) => ymd(new Date(new Date(`${start}T00:00:00Z`).getTime() + n * DAY_MS));

const LIFTS = ['Bench Press', 'Squat', 'Deadlift', 'Overhead Press'];
const LIFT_IDS = ['bench-press', 'back-squat', 'deadlift', 'overhead-press'];

/** A lift-records CSV with no number columns: `days` sessions from `start`, each of `sets` sets of every lift. */
function historyCsv(start: string, days: number, sets: number): { csv: string; dates: string[] } {
  const dates = Array.from({ length: days }, (_, i) => dayFrom(start, i));
  const lines = dates.flatMap((date) =>
    LIFTS.flatMap((lift) => Array.from({ length: sets }, (_, s) => `${date},${lift},${s + 1},100,5,`)),
  );
  return { csv: ['Date,Lift,Set #,Weight,Reps,Notes', ...lines].join('\n'), dates };
}

const oneStretch = (dates: string[], program = 'rpt'): ImportBreakdown => ({
  stretches: [{ program, dates, status: 'completed', statusChosen: false }],
  excludedDates: [],
  nonCycleDates: [],
});

describeOrSkip('import breakdown (#1254, e2e, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  const FLAG = 'IMPORT_ASSIGN_ENABLED';
  const savedFlag = process.env[FLAG];

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanup(owner);
    process.env.DATABASE_URL = APP_DB_URL;
    process.env[FLAG] = 'true';
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup(owner).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const commit = (user: string, csv: string, breakdown: ImportBreakdown) => {
    const boundary = '----BreakdownDbBoundary';
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/programs/rpt/import?mode=commit&destination=lift-records',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${user}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="breakdown"',
        '',
        JSON.stringify(breakdown),
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="upload.csv"',
        'Content-Type: text/csv',
        '',
        csv,
        `--${boundary}--`,
      ].join('\r\n'),
    });
  };

  const written = async (user: string) => ({
    sets: await owner.liftRecord.count({ where: { userId: user } }),
    macrocycles: await owner.macrocycle.count({ where: { userId: user } }),
    batches: await owner.importBatch.count({ where: { userId: user } }),
  });

  it('lets one of two concurrent commits of a file write, and gives the other a 409', async () => {
    const { csv, dates } = historyCsv('2024-01-01', 3, 1);
    // Hold the first writer inside its transaction long enough for the second to reach the lock.
    const append = PrismaLiftRecordRepository.prototype.appendLiftRecords;
    let calls = 0;
    jest.spyOn(PrismaLiftRecordRepository.prototype, 'appendLiftRecords').mockImplementation(async function (
      this: PrismaLiftRecordRepository,
      ...args
    ) {
      if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 2_000));
      return append.apply(this, args);
    });

    const responses = await Promise.all([
      commit(USER_RACE, csv, oneStretch(dates)),
      commit(USER_RACE, csv, oneStretch(dates)),
    ]);

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((r) => r.statusCode === 409)?.json()).toMatchObject({ code: 'import-in-progress' });
    const sets = await owner.liftRecord.groupBy({ by: ['date', 'lift', 'setNum'], where: { userId: USER_RACE }, _count: true });
    expect(sets).toHaveLength(12);
    expect(sets.every((s) => s._count === 1)).toBe(true);
    expect(await written(USER_RACE)).toEqual({ sets: 12, macrocycles: 1, batches: 1 });
  });

  it('writes nothing when a later program’s macrocycle insert fails', async () => {
    const { csv, dates } = historyCsv('2024-01-01', 6, 1);
    const breakdown: ImportBreakdown = {
      stretches: [
        { program: '5-3-1', dates: dates.slice(0, 3), status: 'completed', statusChosen: false },
        { program: 'rpt', dates: dates.slice(3), status: 'completed', statusChosen: false },
      ],
      excludedDates: [],
      nonCycleDates: [],
    };
    // The first program's macrocycle and sets are written before the second insert fails.
    const createMany = PrismaMacrocycleRepository.prototype.createMany;
    let calls = 0;
    jest.spyOn(PrismaMacrocycleRepository.prototype, 'createMany').mockImplementation(async function (
      this: PrismaMacrocycleRepository,
      ...args
    ) {
      if (++calls === 2) throw new Error('forced macrocycle insert failure (#1254 test)');
      return createMany.apply(this, args);
    });

    const res = await commit(USER_MACROCYCLE_FAILS, csv, breakdown);

    expect(calls).toBe(2);
    expect(res.statusCode).toBe(500);
    expect(await written(USER_MACROCYCLE_FAILS)).toEqual({ sets: 0, macrocycles: 0, batches: 0 });
  });

  it('writes nothing when the batch save fails', async () => {
    const { csv, dates } = historyCsv('2024-01-01', 3, 1);
    jest
      .spyOn(PrismaImportBatchRepository.prototype, 'save')
      .mockRejectedValue(new Error('forced batch save failure (#1254 test)'));

    const res = await commit(USER_BATCH_FAILS, csv, oneStretch(dates));

    expect(res.statusCode).toBe(500);
    expect(await written(USER_BATCH_FAILS)).toEqual({ sets: 0, macrocycles: 0, batches: 0 });
  });

  it(
    'commits 5,000 rows dated before 20,000 stored ones, renumbering them all, inside the import transaction',
    async () => {
      // 20 stored legacy macrocycles of 1,000 sets each, all after the file's dates.
      const STORED_MACROCYCLES = 20;
      const SESSIONS_EACH = 50;
      const SETS = 5;
      await owner.macrocycle.createMany({
        data: Array.from({ length: STORED_MACROCYCLES }, (_, k) => ({
          userId: USER_ROW_LIMIT,
          program: 'rpt',
          macrocycleNum: k + 1,
          startDate: new Date(`${dayFrom('2010-01-01', k * 60)}T00:00:00Z`),
          endDate: new Date(`${dayFrom('2010-01-01', k * 60 + SESSIONS_EACH - 1)}T00:00:00Z`),
          status: 'unknown',
          origin: 'legacy',
        })),
      });
      await owner.liftRecord.createMany({
        data: Array.from({ length: STORED_MACROCYCLES }, (_, k) =>
          Array.from({ length: SESSIONS_EACH }, (_, d) =>
            LIFT_IDS.flatMap((lift) =>
              Array.from({ length: SETS }, (_, s) => ({
                userId: USER_ROW_LIMIT,
                program: 'rpt',
                macrocycleNum: k + 1,
                workoutNum: d + 1,
                date: new Date(`${dayFrom('2010-01-01', k * 60 + d)}T00:00:00Z`),
                lift,
                setNum: s + 1,
                weight: 100,
                reps: 5,
              })),
            ),
          ).flat(),
        ).flat(),
      });
      expect((await written(USER_ROW_LIMIT)).sets).toBe(20_000);

      // 250 sessions × 4 lifts × 5 sets = 5,000 rows, all before 2010.
      const { csv, dates } = historyCsv('2000-01-01', 250, SETS);
      const started = Date.now();
      const res = await commit(USER_ROW_LIMIT, csv, oneStretch(dates));
      const durationMs = Date.now() - started;
      // The duration goes in the test output, as the criterion asks.
      // eslint-disable-next-line no-console -- A measurement the reader of the CI log needs.
      console.log(`[#1254] 5,000-row commit renumbering 20,000 stored rows took ${durationMs} ms`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ created: 5_000 });
      expect(durationMs).toBeLessThan(30_000);
      const macrocycles = await owner.macrocycle.findMany({
        where: { userId: USER_ROW_LIMIT, program: 'rpt' },
        orderBy: { macrocycleNum: 'asc' },
      });
      // The import is oldest, so it's number 1 and every stored macrocycle moved up one.
      expect(macrocycles.map((m) => [m.macrocycleNum, m.origin])).toEqual([
        [1, 'imported'],
        ...Array.from({ length: STORED_MACROCYCLES }, (_, k) => [k + 2, 'legacy']),
      ]);
      expect(await owner.liftRecord.count({ where: { userId: USER_ROW_LIMIT, macrocycleNum: 1 } })).toBe(5_000);
      expect(await owner.liftRecord.count({ where: { userId: USER_ROW_LIMIT, macrocycleNum: STORED_MACROCYCLES + 1 } })).toBe(1_000);
    },
    ROW_LIMIT_TEST_TIMEOUT_MS,
  );
});
