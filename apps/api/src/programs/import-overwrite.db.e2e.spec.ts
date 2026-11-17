// Real-Postgres E2E for overwriting stored history with an import (#1182, proposal decision 19):
// the criteria that need a real transaction. A backup that can't be saved must leave everything
// as it was, a dry run must roll its removal back to the savepoint, and an overwrite and its undo
// must round-trip through the Prisma adapters. The in-memory suite (import-overwrite.e2e.spec.ts)
// covers each scope and refusal.
//
// Postgres comes from jest.global-setup.js. Seeding, cleanup and the row reads use the owner;
// every request runs as lifting_app, under forced row-level security.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import multipart from '@fastify/multipart';
import type { ImportAssignResponse, ImportBreakdown, ImportCommitResponse, ImportDryRunResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { injectPage } from '../testing/macrocycle-id';
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
jest.setTimeout(DB_E2E_HOOK_TIMEOUT_MS);

const USER_NO_BACKUP = 'import-overwrite-db-no-backup';
const USER_DRY_RUN = 'import-overwrite-db-dry-run';
const USER_UNDO = 'import-overwrite-db-undo';
const USERS = [USER_NO_BACKUP, USER_DRY_RUN, USER_UNDO];

/** The tables an overwrite reads or writes, by Prisma delegate. */
const MODELS = [
  'liftRecord',
  'macrocycle',
  'macrocycleDashboard',
  'macrocycleScheduledWorkout',
  'workoutDateOverride',
  'workoutSkipOverride',
  'importBatch',
  'dataSnapshot',
] as const;

interface Delegate {
  findMany(args: { where: { userId: string } }): Promise<Array<Record<string, unknown>>>;
  deleteMany(args: { where: { userId: { in: string[] } } }): Promise<unknown>;
}
const delegate = (owner: PrismaClient, model: string) => (owner as unknown as Record<string, Delegate>)[model] as Delegate;

async function cleanup(owner: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  for (const model of MODELS) await delegate(owner, model).deleteMany({ where });
  await owner.userSettings.deleteMany({ where });
}

/**
 * A user's rows in every table an overwrite touches, without the ids and timestamps a restore
 * gives anew, each table sorted, so two reads compare whatever order the rows went in.
 */
async function rowsOf(owner: PrismaClient, userId: string, models: readonly string[] = MODELS) {
  const out: Record<string, string[]> = {};
  for (const model of models) {
    const rows = await delegate(owner, model).findMany({ where: { userId } });
    out[model] = rows
      .map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...row }) =>
        JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)))),
      )
      .sort();
  }
  return out;
}

/** What {@link seedHistory} stores, so a before-and-after comparison can't pass on empty tables. */
function expectSeeded(rows: Record<string, string[]>): void {
  // The imported run's 18 sets and the live macrocycle's one.
  expect(rows['liftRecord']).toHaveLength(19);
  expect(rows['macrocycle']).toHaveLength(2);
  expect(rows['macrocycleDashboard']).toHaveLength(1);
  expect(rows['workoutSkipOverride']).toHaveLength(1);
  expect(rows['workoutDateOverride']).toHaveLength(1);
  expect(rows['macrocycleScheduledWorkout']?.length).toBeGreaterThan(0);
}

const DAY_MS = 86_400_000;
const TODAY = Math.floor(Date.now() / DAY_MS) * DAY_MS;
/** `n` days from today: negative is past. */
const day = (n: number) => new Date(TODAY + n * DAY_MS).toISOString().slice(0, 10);

const RPT_DAYS = [
  ['Bench Press', 'Barbell Row', 'Overhead Press'],
  ['Squat', 'Romanian Deadlift', 'Calf Raises'],
  ['Deadlift', 'Weighted Pull-ups', 'Dips'],
];

/** `count` RPT sessions of three sets, every other day from `start`. */
function run(start: number, count: number, weight: number): { csv: string; dates: string[] } {
  const dates = Array.from({ length: count }, (_, i) => day(start + i * 2));
  const lines = dates.flatMap((date, i) => (RPT_DAYS[i % 3] ?? []).map((lift) => `${date},${lift},1,${weight},8,`));
  return { csv: ['Date,Lift,Set #,Weight,Reps,Notes', ...lines].join('\n'), dates };
}

const breakdownOf = (dates: string[], overwrite?: ImportBreakdown['overwrite']): ImportBreakdown => ({
  stretches: [{ program: 'rpt', dates, status: 'completed', statusChosen: false }],
  excludedDates: [],
  nonCycleDates: [],
  ...(overwrite ? { overwrite } : {}),
});

describeOrSkip('import overwrite (#1182, e2e, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  const FLAG = 'IMPORT_ASSIGN_ENABLED';
  const savedFlag = process.env[FLAG];

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanup(owner);
    for (const userId of USERS) {
      await owner.userSettings.create({ data: { userId, workoutSchedule: { type: 'fixed', days: [0, 1, 2, 3, 4, 5, 6] } } });
    }
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

  const server = () => app.getHttpAdapter().getInstance();

  const importCsv = (user: string, csv: string, query: string, breakdown?: ImportBreakdown) => {
    const boundary = '----OverwriteDbBoundary';
    const fields: Record<string, string> = { today: day(0), ...(breakdown ? { breakdown: JSON.stringify(breakdown) } : {}) };
    return server().inject({
      method: 'POST',
      url: `/programs/rpt/import${query}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${user}` },
      payload: [
        ...Object.entries(fields).flatMap(([name, value]) => [
          `--${boundary}`,
          `Content-Disposition: form-data; name="${name}"`,
          '',
          value,
        ]),
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="upload.csv"',
        'Content-Type: text/csv',
        '',
        csv,
        `--${boundary}--`,
      ].join('\r\n'),
    });
  };

  const commit = async (user: string, file: ReturnType<typeof run>, overwrite?: ImportBreakdown['overwrite']) => {
    const res = await importCsv(user, file.csv, '?mode=commit&destination=lift-records', breakdownOf(file.dates, overwrite));
    expect(res.statusCode).toBe(200);
    return res.json<ImportCommitResponse>();
  };

  const allCounts = async (user: string, file: ReturnType<typeof run>) => {
    const res = await importCsv(user, file.csv, '?mode=assign&destination=lift-records');
    expect(res.statusCode).toBe(200);
    return res.json<ImportAssignResponse>().overwrite.all;
  };

  const page = (user: string, method: 'POST' | 'PATCH', url: string, body: unknown) =>
    injectPage(app, {
      method,
      url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user}` },
      payload: JSON.stringify(body),
    });

  /** An imported run, then a live macrocycle with a set, a skipped workout and a moved one. */
  async function seedHistory(user: string): Promise<void> {
    await commit(user, run(-200, 6, 100));
    expect((await page(user, 'POST', '/programs/rpt/macrocycles/initialize', { macrocycleDate: day(-30) })).statusCode).toBe(201);
    const live = await owner.macrocycle.findFirstOrThrow({ where: { userId: user, origin: 'live' } });
    const n = live.macrocycleNum;
    const set = { lift: 'Bench Press', setNum: 1, weight: 135, reps: 5, macrocycleNum: n, workoutNum: 1, date: day(-30) };
    expect((await page(user, 'POST', '/programs/rpt/lift-records', set)).statusCode).toBe(201);
    expect((await page(user, 'POST', `/programs/rpt/macrocycles/${n}/workouts/2/skip`, {})).statusCode).toBe(204);
    expect((await page(user, 'PATCH', `/programs/rpt/macrocycles/${n}/workouts/3/reschedule`, { newDate: day(-21) })).statusCode).toBe(204);
  }

  it('replaces nothing and imports nothing when the backup can’t be saved', async () => {
    await seedHistory(USER_NO_BACKUP);
    const file = run(-150, 6, 200);
    const counts = await allCounts(USER_NO_BACKUP, file);
    const before = await rowsOf(owner, USER_NO_BACKUP);
    expectSeeded(before);

    // Refused for this test's user only: revoking the insert from lifting_app would also fail a
    // suite running beside this one that saves a snapshot.
    await owner.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION import_overwrite_e2e_refuse_backup() RETURNS trigger AS $$
      BEGIN
        IF NEW."userId" = '${USER_NO_BACKUP}' THEN RAISE EXCEPTION 'backup refused by the test'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await owner.$executeRawUnsafe(
      'CREATE TRIGGER import_overwrite_e2e_refuse_backup BEFORE INSERT ON "data_snapshot" FOR EACH ROW EXECUTE FUNCTION import_overwrite_e2e_refuse_backup()',
    );
    let res: Awaited<ReturnType<typeof importCsv>>;
    try {
      res = await importCsv(USER_NO_BACKUP, file.csv, '?mode=commit&destination=lift-records', breakdownOf(file.dates, { scope: { kind: 'all' }, counts }));
    } finally {
      await owner.$executeRawUnsafe('DROP TRIGGER IF EXISTS import_overwrite_e2e_refuse_backup ON "data_snapshot"');
      await owner.$executeRawUnsafe('DROP FUNCTION IF EXISTS import_overwrite_e2e_refuse_backup()');
    }

    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/couldn’t be backed up/);
    expect(await rowsOf(owner, USER_NO_BACKUP)).toEqual(before);
  });

  it('rolls a dry run’s removal back, and counts every row of the file as new', async () => {
    await seedHistory(USER_DRY_RUN);
    const file = run(-200, 6, 100);
    const counts = await allCounts(USER_DRY_RUN, file);
    const before = await rowsOf(owner, USER_DRY_RUN);
    expectSeeded(before);

    const res = await importCsv(USER_DRY_RUN, file.csv, '?mode=dry-run&destination=lift-records', breakdownOf(file.dates, { scope: { kind: 'all' }, counts }));
    expect(res.statusCode).toBe(200);
    // Every row would duplicate a stored set, but those sets are what the overwrite removes.
    expect(res.json<ImportDryRunResponse>()).toMatchObject({ created: 18, skipped: 0 });
    expect(await rowsOf(owner, USER_DRY_RUN)).toEqual(before);
  });

  it('puts everything back on undo, live schedule and overrides included, and leaves no backup', async () => {
    await seedHistory(USER_UNDO);
    // The rows the undo must put back. Import batches are left out: the overwrite's own batch
    // goes on undo, and the earlier one's ids and pre-image are compared below.
    const restored = MODELS.filter((m) => m !== 'importBatch');
    const before = await rowsOf(owner, USER_UNDO, restored);
    expectSeeded(before);
    const [earlier] = await owner.importBatch.findMany({ where: { userId: USER_UNDO } });

    const file = run(-150, 6, 200);
    const { batchId } = await commit(USER_UNDO, file, { scope: { kind: 'all' }, counts: await allCounts(USER_UNDO, file) });
    expect(await owner.liftRecord.count({ where: { userId: USER_UNDO, weight: 100 } })).toBe(0);
    expect(await owner.workoutSkipOverride.count({ where: { userId: USER_UNDO } })).toBe(0);
    expect(await owner.dataSnapshot.count({ where: { userId: USER_UNDO, kind: 'overwrite' } })).toBe(1);

    const undo = await server().inject({
      method: 'POST',
      url: `/programs/rpt/import/${batchId}/undo`,
      headers: { authorization: `Bearer ${USER_UNDO}` },
    });
    expect(undo.statusCode).toBe(200);

    expect(await rowsOf(owner, USER_UNDO, restored)).toEqual(before);
    expect(await owner.importBatch.findMany({ where: { userId: USER_UNDO } })).toEqual([earlier]);
  });
});
