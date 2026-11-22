// Real-Postgres E2E for Clear data and its snapshots (#1309, proposal decisions 20 and 21, ADR-044).
// `app` boots against the restricted lifting_app role, so requests run through forced row-level
// security; `prisma` is the owner connection, used only to seed, inspect and clean up. The
// in-memory suite (snapshots.e2e.spec.ts) covers the rest of the API behaviour.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { LIFT_RECORD_EXPORT_HEADERS, parseCsvText } from '@lifting-logbook/core';
import type { ClearTrainingDataResponse, LiftRecordExportPartsResponse, TrainingDataCounts } from '@lifting-logbook/types';
import { MACROCYCLE_LOCK_NAMESPACE } from '../adapters/prisma/macrocycle.repository';
import { PrismaService } from '../adapters/prisma/prisma.service';
import { AppModule } from '../app.module';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { NUMBERED_TRAINING_TABLES, TRAINING_TABLES, TrainingTable } from '../ports/ITrainingDataRepository';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { ExpiryLogEntry, runExpiryJob } from './expire-snapshots.job';
import { TRAINING_DATA_TX_TIMEOUT_MS } from './snapshots.controller';

// See programs.db.e2e.spec.ts (#567): headroom for a contended full-suite Windows run. The tests
// clear and restore whole histories, so they take it too.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;
jest.setTimeout(DB_E2E_HOOK_TIMEOUT_MS);

const USER_CLEARED = 'db-e2e-snapshots-cleared';
const USER_OTHER = 'db-e2e-snapshots-other';
const USER_NEWER = 'db-e2e-snapshots-newer';
const USER_NO_BACKUP = 'db-e2e-snapshots-no-backup';
const USER_ISOLATED = 'db-e2e-snapshots-isolated';
const USER_LONG = 'db-e2e-snapshots-long';
const USER_PAGE_WRITE = 'db-e2e-snapshots-page-write';
const USER_ROW_WRITE = 'db-e2e-snapshots-row-write';
const USER_UNKNOWN_KIND = 'db-e2e-snapshots-unknown-kind';
const USERS = [USER_CLEARED, USER_OTHER, USER_NEWER, USER_NO_BACKUP, USER_ISOLATED, USER_LONG, USER_PAGE_WRITE, USER_ROW_WRITE, USER_UNKNOWN_KIND];
const PROGRAM = '5-3-1';
const CUSTOM_PROGRAM_IDS: Record<string, string> = {
  [USER_CLEARED]: '0e130900-0000-4000-8000-000000000001',
  [USER_OTHER]: '0e130900-0000-4000-8000-000000000002',
};

/** Decision 20's cleared tables, by Prisma model. */
const CLEARED = [
  'LiftRecord',
  'Macrocycle',
  'MacrocycleDashboard',
  'MacrocycleScheduledWorkout',
  'TrainingMax',
  'TrainingMaxHistory',
  'LiftModificationMax',
  'WorkoutDateOverride',
  'WorkoutSkipOverride',
  'WorkoutLiftOverride',
  'FocusDayState',
  'ImportBatch',
];
/** Setup Clear data keeps, plus the hourly count of import suggestion requests. */
const KEPT = [
  'BodyWeight',
  'StrengthGoal',
  'LiftMetadata',
  'CustomLift',
  'LiftModification',
  'MissingMaxDismissal',
  'UserSettings',
  'FocusBlock',
  'SupplementDayType',
  'SupplementItem',
  'SupplementDose',
  'SupplementMixPart',
  'SupplementChange',
  'CustomProgram',
  'CustomProgramSpec',
  'ImportSuggestionUsage',
];

/** Each cleared table's Prisma model. */
const MODEL_OF: Record<TrainingTable, string> = {
  macrocycles: 'Macrocycle',
  liftRecords: 'LiftRecord',
  macrocycleDashboards: 'MacrocycleDashboard',
  macrocycleScheduledWorkouts: 'MacrocycleScheduledWorkout',
  trainingMaxes: 'TrainingMax',
  trainingMaxHistory: 'TrainingMaxHistory',
  liftModificationMaxes: 'LiftModificationMax',
  workoutDateOverrides: 'WorkoutDateOverride',
  workoutSkipOverrides: 'WorkoutSkipOverride',
  workoutLiftOverrides: 'WorkoutLiftOverride',
  focusDayStates: 'FocusDayState',
  importBatches: 'ImportBatch',
};

/**
 * The columns a snapshot's payload holds for each cleared table, as of payload version 1. A
 * snapshot stays restorable for 30 days, so when a migration changes these, one taken before it
 * still holds the old columns: give a new column a default, or raise the payload version in
 * snapshot-payload.ts and read the old one, then update this list.
 */
const PAYLOAD_COLUMNS: Record<string, string[]> = {
  FocusDayState: ['id', 'macrocycleNum', 'program', 'state', 'updatedAt', 'userId', 'workoutNum'],
  ImportBatch: ['createdAt', 'destination', 'groupId', 'id', 'macrocycles', 'preImage', 'program', 'userId'],
  LiftModificationMax: ['dateUpdated', 'id', 'modificationId', 'program', 'userId', 'weight'],
  LiftRecord: [
    'date',
    'id',
    'lift',
    'macrocycleNum',
    'modifications',
    'notes',
    'occurrence',
    'program',
    'reps',
    'setNum',
    'userId',
    'weight',
    'workoutNum',
  ],
  Macrocycle: [
    'backfillClosedAt',
    'backfillNumber',
    'backfilledAt',
    'createdAt',
    'endDate',
    'id',
    'importedThrough',
    'macrocycleNum',
    'origin',
    'program',
    'startDate',
    'status',
    'statusChosen',
    'unmatched',
    'userId',
  ],
  MacrocycleDashboard: [
    'id',
    'macrocycleDate',
    'macrocycleNum',
    'macrocycleStartWeekday',
    'macrocycleUnit',
    'program',
    'programType',
    'sheetName',
    'userId',
  ],
  MacrocycleScheduledWorkout: ['id', 'macrocycleNum', 'program', 'scheduledDate', 'userId', 'weekNum', 'workoutNum'],
  TrainingMax: ['dateUpdated', 'id', 'lift', 'program', 'userId', 'weight'],
  TrainingMaxHistory: [
    'createdAt',
    'date',
    'goalMet',
    'id',
    'isPR',
    'lift',
    'modificationId',
    'program',
    'reps',
    'source',
    'userId',
    'weight',
  ],
  WorkoutDateOverride: ['createdAt', 'id', 'macrocycleNum', 'newDate', 'program', 'userId', 'workoutNum'],
  WorkoutLiftOverride: ['action', 'createdAt', 'id', 'lift', 'macrocycleNum', 'program', 'replacedBy', 'userId', 'workoutNum'],
  WorkoutSkipOverride: ['id', 'macrocycleNum', 'program', 'reason', 'skippedAt', 'userId', 'workoutNum'],
};

/** A model's stored columns, by name. */
function columnsOf(model: string): string[] {
  const found = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!found) throw new Error(`no Prisma model ${model}`);
  return found.fields
    .filter((f) => f.kind !== 'object')
    .map((f) => f.name)
    .sort();
}

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallback never runs (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_DATABASE_URL ?? '';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface CountDelegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  findMany(args: { where: Record<string, unknown>; orderBy: { id: 'asc' } }): Promise<unknown[]>;
}

/** A model's Prisma delegate, reached by name so the lists above drive the checks. */
function delegate(prisma: PrismaClient, model: string): CountDelegate {
  const found = (prisma as unknown as Record<string, CountDelegate | undefined>)[model.charAt(0).toLowerCase() + model.slice(1)];
  if (!found) throw new Error(`no Prisma delegate for ${model}`);
  return found;
}

/** Spec rows belong to a user through their custom program. */
const whereUser = (model: string, userId: string) =>
  model === 'CustomProgramSpec' ? { program: { userId } } : { userId };

async function countsOf(prisma: PrismaClient, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const model of [...CLEARED, ...KEPT, 'DataSnapshot']) {
    out[model] = await delegate(prisma, model).count({ where: whereUser(model, userId) });
  }
  return out;
}

async function cleanUsers(prisma: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  for (const model of [...CLEARED, ...KEPT, 'DataSnapshot']) {
    if (model === 'CustomProgramSpec') continue; // Cascades from its program.
    await (delegate(prisma, model) as unknown as { deleteMany(args: unknown): Promise<unknown> }).deleteMany({ where });
  }
}

/** A row in every cleared and kept table, two macrocycles' sets, and a formula in a note. */
async function seedUser(prisma: PrismaClient, userId: string): Promise<void> {
  const program = PROGRAM;
  const workout = { userId, program, macrocycleNum: 2, workoutNum: 1 };
  const set = (macrocycleNum: number, date: string, weight: number, notes = '') => ({
    userId,
    program,
    macrocycleNum,
    workoutNum: 1,
    date: day(date),
    lift: 'Squat',
    setNum: 1,
    weight,
    reps: 5,
    notes,
  });
  await prisma.macrocycle.createMany({
    data: [
      { userId, program, macrocycleNum: 1, startDate: day('2025-01-06'), endDate: day('2025-02-17'), status: 'completed', origin: 'imported' },
      { userId, program, macrocycleNum: 2, startDate: day('2025-06-02'), status: 'in-progress', origin: 'live' },
    ],
  });
  await prisma.liftRecord.createMany({
    data: [set(1, '2025-01-06', 999, '=SUM(A1)'), set(2, '2025-06-02', 225), { ...set(2, '2025-06-04', 230), workoutNum: 2 }],
  });
  await prisma.macrocycleDashboard.create({
    data: {
      userId,
      program,
      macrocycleUnit: 'month',
      macrocycleNum: 2,
      macrocycleDate: day('2025-06-02'),
      sheetName: 'seed',
      macrocycleStartWeekday: 'Monday',
    },
  });
  await prisma.macrocycleScheduledWorkout.create({ data: { ...workout, weekNum: 1, scheduledDate: day('2025-06-02') } });
  await prisma.trainingMax.create({ data: { userId, program, lift: 'Squat', weight: 300, dateUpdated: day('2025-06-01') } });
  await prisma.trainingMaxHistory.create({
    data: { userId, program, lift: 'Squat', weight: 300, date: day('2025-06-01'), source: 'test' },
  });
  const modification = await prisma.liftModification.create({ data: { userId, lift: 'squat', name: 'Paused' } });
  await prisma.liftModificationMax.create({
    data: { userId, program, modificationId: modification.id, weight: 250, dateUpdated: day('2025-06-01') },
  });
  await prisma.workoutDateOverride.create({ data: { ...workout, workoutNum: 3, newDate: day('2025-06-07') } });
  await prisma.workoutSkipOverride.create({ data: { ...workout, workoutNum: 4, reason: 'travel' } });
  await prisma.workoutLiftOverride.create({ data: { ...workout, workoutNum: 5, lift: 'Squat', action: 'remove' } });
  await prisma.focusDayState.create({ data: { ...workout, state: { placement: 'after' } } });
  await prisma.importBatch.create({
    data: {
      userId,
      program,
      destination: 'lift-records',
      preImage: { [`1:1:2025-01-06:Squat:1`]: { kind: 'created', wrote: { weight: 999 } } },
    },
  });
  await prisma.bodyWeight.create({ data: { userId, program, date: day('2025-06-01'), weight: 180, unit: 'lbs' } });
  await prisma.strengthGoal.create({ data: { userId, program, lift: 'Squat', goalType: 'absolute', target: 400, unit: 'lbs' } });
  await prisma.liftMetadata.create({ data: { userId, lift: 'Squat', muscleGroups: ['legs'], substitutions: [] } });
  await prisma.customLift.create({
    data: { userId, name: 'Belt Squat', classification: 'accessory', patterns: [], jointActions: [] },
  });
  await prisma.missingMaxDismissal.create({ data: { userId, program, liftId: 'romanian-deadlift' } });
  await prisma.userSettings.create({ data: { userId, activeProgram: program } });
  await prisma.focusBlock.create({
    data: {
      userId,
      series: 'arms',
      area: 'Biceps',
      period: 'monthly',
      align: 'calendar',
      start: day('2025-06-01'),
      selection: 'rules',
      overlap: 'swap',
      progression: 'double',
      priority: 1,
      timer: {},
      onEnd: 'prompt',
      pool: [],
    },
  });
  await prisma.supplementDayType.create({ data: { userId, id: 'lift', name: 'Lift', position: 0 } });
  await prisma.supplementItem.create({
    data: {
      id: `${userId}-mix`,
      userId,
      name: 'Pre-workout',
      keyCompound: '',
      timing: '',
      shortNote: '',
      longNote: '',
      status: 'active',
      unverified: false,
      links: [],
      ingredients: [],
      isMix: true,
      position: 0,
    },
  });
  await prisma.supplementDose.create({
    data: { userId, itemId: `${userId}-mix`, position: 0, slot: 'pre', amount: '1 scoop', servings: 1, dayTypes: ['lift'] },
  });
  await prisma.supplementMixPart.create({
    data: { userId, mixId: `${userId}-mix`, position: 0, partItemId: `${userId}-part`, name: 'Creatine', ingredients: [] },
  });
  await prisma.supplementChange.create({ data: { userId, seq: 1, date: day('2025-06-01'), type: 'mix_split', payload: {} } });
  const customProgramId = CUSTOM_PROGRAM_IDS[userId];
  if (customProgramId) {
    await prisma.customProgram.create({
      data: {
        id: customProgramId,
        userId,
        name: 'My plan',
        specs: {
          create: { week: 1, lift: 'Squat', increment: 5, order: 1, sets: 3, reps: 5, warmUpPct: '.5', wtDecrementPct: 0, activation: '' },
        },
      },
    });
  }
  await prisma.importSuggestionUsage.create({ data: { userId } });
}

/** An exported CSV's rows as objects keyed by header. */
function rowsOf(csv: string): Record<string, string>[] {
  const [header = [], ...rows] = parseCsvText(csv).map((r) => r.map((c) => String(c ?? '')));
  expect(header).toEqual([...LIFT_RECORD_EXPORT_HEADERS]);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

describeOrSkip('Clear data and snapshots (#1309, e2e, PrismaRepositoryFactory)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  const inject = (user: string, method: string, url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url,
        headers:
          body === undefined
            ? { authorization: `Bearer ${user}` }
            : { 'content-type': 'application/json', authorization: `Bearer ${user}` },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
  const apiCounts = async (user: string) => {
    const res = await inject(user, 'GET', '/users/me/training-data/counts');
    expect(res.statusCode).toBe(200);
    return res.json<TrainingDataCounts>();
  };
  const clear = async (user: string) => {
    const res = await inject(user, 'POST', '/users/me/training-data/clear', { counts: await apiCounts(user) });
    expect(res.statusCode).toBe(201);
    return res.json<ClearTrainingDataResponse>().snapshot;
  };
  /** Runs `body` as lifting_app with `userId` as the current user, as the API's transactions do. */
  const asAppUser = <T>(userId: string, body: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    app.get(PrismaService, { strict: false }).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return body(tx);
    });

  beforeAll(async () => {
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
    prisma = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanUsers(prisma);
    for (const user of USERS) await seedUser(prisma, user);

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

  it('runs as the restricted role, not the owner', async () => {
    const rows = await app.get(PrismaService, { strict: false }).$queryRaw<
      Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT current_user::text AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ role: 'lifting_app', rolsuper: false, rolbypassrls: false }]);
  });

  it('decides for every model in the schema whether Clear data removes it', () => {
    const models = Prisma.dmmf.datamodel.models.map((model) => model.name).sort();
    expect(models).toEqual([...CLEARED, ...KEPT, 'DataSnapshot'].sort());
    expect(TRAINING_TABLES.map((table) => MODEL_OF[table]).sort()).toEqual([...CLEARED].sort());
  });

  it('moves every cleared table that holds a macrocycle number on restore', () => {
    const numbered = CLEARED.filter((model) => columnsOf(model).includes('macrocycleNum')).sort();
    expect(NUMBERED_TRAINING_TABLES.map((table) => MODEL_OF[table]).sort()).toEqual(numbered);
  });

  it('pins the columns a snapshot holds, so a schema change decides what an older snapshot restores', () => {
    expect(Object.fromEntries(CLEARED.map((model) => [model, columnsOf(model)]))).toEqual(PAYLOAD_COLUMNS);
  });

  it(
    'clears and restores a long history inside the transaction timeout',
    async () => {
      // A heavy lifter's ten years is about 78,000 sets (SNAPSHOT_HISTORY_SETS=78000 measures it);
      // CI runs a lighter history so the suite stays quick.
      const sets = Number(process.env.SNAPSHOT_HISTORY_SETS ?? 12_000);
      const perMacrocycle = 600; // 20 workouts of 6 lifts by 5 sets.
      const macrocycles = Math.ceil(sets / perMacrocycle);
      const userId = USER_LONG;
      const first = day('2010-01-04').getTime();
      const startOf = (i: number) => new Date(first + i * 28 * 86_400_000);
      // The seeded macrocycles hold numbers 1 and 2 and start in 2025.
      await prisma.macrocycle.createMany({
        data: Array.from({ length: macrocycles }, (_, i) => ({
          userId,
          program: PROGRAM,
          macrocycleNum: i + 3,
          startDate: startOf(i),
          endDate: new Date(startOf(i).getTime() + 25 * 86_400_000),
          status: 'completed',
          origin: 'imported',
        })),
      });
      const rows = [];
      for (let i = 0; i < macrocycles; i++) {
        for (let w = 0; w < 20; w++) {
          const date = new Date(startOf(i).getTime() + (Math.floor(w / 5) * 7 + (w % 5)) * 86_400_000);
          for (let lift = 0; lift < 6; lift++) {
            for (let setNum = 1; setNum <= 5; setNum++) {
              rows.push({ userId, program: PROGRAM, macrocycleNum: i + 3, workoutNum: w + 1, date, lift: `Lift ${lift}`, setNum, weight: 100 + lift, reps: 5 });
            }
          }
        }
      }
      for (let i = 0; i < rows.length; i += 10_000) await prisma.liftRecord.createMany({ data: rows.slice(i, i + 10_000) });
      const counts = await apiCounts(userId);

      let started = Date.now();
      const snapshot = await clear(userId);
      const clearMs = Date.now() - started;
      started = Date.now();
      // A transaction past TRAINING_DATA_TX_TIMEOUT_MS fails the request with a 503.
      expect((await inject(userId, 'POST', `/users/me/snapshots/${snapshot.id}/restore`)).statusCode).toBe(200);
      const restoreMs = Date.now() - started;

      expect(await apiCounts(userId)).toEqual(counts);
      if (process.env.SNAPSHOT_HISTORY_SETS) {
        process.stdout.write(`${JSON.stringify({ sets: rows.length, clearMs, restoreMs, timeoutMs: TRAINING_DATA_TX_TIMEOUT_MS })}\n`);
      }
    },
    120_000,
  );

  it('clears only decision 20’s tables, leaves another user alone, and a restore brings every row back', async () => {
    const before = await countsOf(prisma, USER_CLEARED);
    const otherBefore = await countsOf(prisma, USER_OTHER);
    // Every table is seeded, so a table the clear misses or wrongly clears fails below.
    expect(Object.entries(before).filter(([model, n]) => model !== 'DataSnapshot' && n === 0)).toEqual([]);
    const rowsBefore = Object.fromEntries(
      await Promise.all(
        CLEARED.map(async (model) => [model, await delegate(prisma, model).findMany({ where: { userId: USER_CLEARED }, orderBy: { id: 'asc' } })]),
      ),
    );
    const offered = await inject(USER_CLEARED, 'GET', '/users/me/export/lift-records');
    expect(offered.statusCode).toBe(200);

    const snapshot = await clear(USER_CLEARED);

    const after = await countsOf(prisma, USER_CLEARED);
    expect(Object.fromEntries(CLEARED.map((m) => [m, after[m]]))).toEqual(Object.fromEntries(CLEARED.map((m) => [m, 0])));
    expect(Object.fromEntries(KEPT.map((m) => [m, after[m]]))).toEqual(Object.fromEntries(KEPT.map((m) => [m, before[m]])));
    expect(after['DataSnapshot']).toBe(1);
    expect(await countsOf(prisma, USER_OTHER)).toEqual(otherBefore);

    // The snapshot's sets download as the CSV the clear offered, with the formula escaped.
    const parts = await inject(USER_CLEARED, 'GET', `/users/me/snapshots/${snapshot.id}/lift-records/parts`);
    expect(parts.statusCode).toBe(200);
    const { split } = parts.json<LiftRecordExportPartsResponse>();
    const download = await inject(USER_CLEARED, 'GET', `/users/me/snapshots/${snapshot.id}/lift-records?part=1&split=${split}`);
    expect(download.statusCode).toBe(200);
    expect(rowsOf(download.body)).toEqual(rowsOf(offered.body));
    expect(rowsOf(download.body).map((r) => r['Notes'])).toContain("'=SUM(A1)");

    expect((await inject(USER_CLEARED, 'POST', `/users/me/snapshots/${snapshot.id}/restore`)).statusCode).toBe(200);

    for (const model of CLEARED) {
      const rows = await delegate(prisma, model).findMany({ where: { userId: USER_CLEARED }, orderBy: { id: 'asc' } });
      expect({ model, rows }).toEqual({ model, rows: rowsBefore[model] });
    }
    expect(await prisma.dataSnapshot.count({ where: { userId: USER_CLEARED } })).toBe(0);
  });

  it('keeps a macrocycle, set, dashboard and max stored since the clear, and numbers the restored one by date', async () => {
    const snapshot = await clear(USER_NEWER);
    const userId = USER_NEWER;
    // What a new initialize and a logged set leave behind.
    await prisma.macrocycle.create({
      data: { userId, program: PROGRAM, macrocycleNum: 1, startDate: day('2026-01-05'), status: 'in-progress', origin: 'live' },
    });
    await prisma.macrocycleDashboard.create({
      data: {
        userId,
        program: PROGRAM,
        macrocycleUnit: 'month',
        macrocycleNum: 1,
        macrocycleDate: day('2026-01-05'),
        sheetName: 'new',
        macrocycleStartWeekday: 'Monday',
      },
    });
    await prisma.trainingMax.create({ data: { userId, program: PROGRAM, lift: 'Squat', weight: 350, dateUpdated: day('2026-01-05') } });
    await prisma.liftRecord.create({
      data: { userId, program: PROGRAM, macrocycleNum: 1, workoutNum: 1, date: day('2026-01-05'), lift: 'Squat', setNum: 1, weight: 275, reps: 5 },
    });

    expect((await inject(userId, 'POST', `/users/me/snapshots/${snapshot.id}/restore`)).statusCode).toBe(200);

    const macrocycles = await prisma.macrocycle.findMany({ where: { userId }, orderBy: { macrocycleNum: 'asc' } });
    expect(macrocycles.map((m) => [m.macrocycleNum, m.startDate, m.origin, m.status])).toEqual([
      [1, day('2025-01-06'), 'imported', 'completed'],
      [2, day('2025-06-02'), 'live', 'abandoned'],
      [3, day('2026-01-05'), 'live', 'in-progress'],
    ]);
    expect(macrocycles[1]?.endDate).toEqual(day('2025-06-04'));
    expect(await prisma.macrocycleDashboard.findMany({ where: { userId } })).toEqual([
      expect.objectContaining({ macrocycleNum: 3, macrocycleDate: day('2026-01-05'), sheetName: 'new' }),
    ]);
    expect((await prisma.trainingMax.findMany({ where: { userId } })).map((m) => [m.lift, m.weight])).toEqual([['Squat', 350]]);
    const sets = await prisma.liftRecord.findMany({ where: { userId }, orderBy: [{ macrocycleNum: 'asc' }, { date: 'asc' }] });
    expect(sets.map((r) => [r.macrocycleNum, r.date, r.weight])).toEqual([
      [1, day('2025-01-06'), 999],
      [2, day('2025-06-02'), 225],
      [2, day('2025-06-04'), 230],
      [3, day('2026-01-05'), 275],
    ]);
  });

  it('clears nothing when the snapshot can’t be saved', async () => {
    const before = await countsOf(prisma, USER_NO_BACKUP);
    const counts = await apiCounts(USER_NO_BACKUP);
    // Refused for this test's user only. Revoking the insert from lifting_app also failed an
    // import-overwrite suite saving its backup in another worker at the same moment (#1408).
    // Created with OR REPLACE, so a run killed before the cleanup doesn't fail the next one.
    let status: number;
    try {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION snapshots_e2e_refuse_backup() RETURNS trigger AS $$
        BEGIN
          IF NEW."userId" = '${USER_NO_BACKUP}' THEN RAISE EXCEPTION 'backup refused by the test'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(
        'CREATE OR REPLACE TRIGGER snapshots_e2e_refuse_backup BEFORE INSERT ON "data_snapshot" FOR EACH ROW EXECUTE FUNCTION snapshots_e2e_refuse_backup()',
      );
      status = (await inject(USER_NO_BACKUP, 'POST', '/users/me/training-data/clear', { counts })).statusCode;
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS snapshots_e2e_refuse_backup ON "data_snapshot"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS snapshots_e2e_refuse_backup()');
    }

    expect(status).toBe(503);
    expect(await countsOf(prisma, USER_NO_BACKUP)).toEqual(before);
  });

  describe('a write committed while clear runs', () => {
    /**
     * Opens a transaction as lifting_app and `userId`, runs `write` in it, starts a clear of
     * `counts` and waits until the clear is blocked on that transaction, then commits it.
     * Returns the clear's response.
     */
    async function clearDuring(userId: string, counts: TrainingDataCounts, write: (client: Client) => Promise<void>) {
      const client = new Client({ connectionString: APP_ROLE_URL });
      await client.connect();
      let response: ReturnType<typeof inject> | undefined;
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        await write(client);
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const writer = rows[0]?.pid;
        response = inject(userId, 'POST', '/users/me/training-data/clear', { counts });
        // The clear's wait shows as a backend blocked by the writer. A wait on the macrocycle lock
        // gives up after 5 s, so this checks often; a wait on a row lock has no limit.
        const deadline = Date.now() + 4_000;
        let blocked = 0;
        while (blocked === 0 && Date.now() < deadline) {
          const waiting = await prisma.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${writer}::int = ANY(pg_blocking_pids(pid))`;
          blocked = waiting[0]?.n ?? 0;
          if (blocked === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (blocked !== 1) throw new Error(`Expected the clear to be blocked on the writer within 4 s; ${blocked} backends were.`);
        await client.query('COMMIT');
        return await response;
      } finally {
        // Ending the connection rolls back a write left open by a failure above, which releases a
        // clear still waiting on it; waiting for that clear keeps it from outliving the test.
        await client.end();
        await response?.catch(() => undefined);
      }
    }

    it('waits for a page write holding the macrocycle lock, then saves and clears the set it added', async () => {
      const before = await apiCounts(USER_PAGE_WRITE);

      const res = await clearDuring(USER_PAGE_WRITE, { ...before, liftRecords: before.liftRecords + 1 }, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, $2))', [USER_PAGE_WRITE, MACROCYCLE_LOCK_NAMESPACE]);
        await client.query(
          `INSERT INTO "lift_record" ("id", "userId", "program", "macrocycleNum", "workoutNum", "date", "lift", "setNum", "weight", "reps")
           VALUES ('db-e2e-page-write-set', $1, $2, 2, 3, '2025-06-09', 'Squat', 1, 235, 5)`,
          [USER_PAGE_WRITE, PROGRAM],
        );
      });

      // A REPEATABLE READ clear fixed its view before the wait, so it couldn't see this set.
      expect(res.statusCode).toBe(201);
      expect(res.json<ClearTrainingDataResponse>().snapshot.counts.liftRecords).toBe(before.liftRecords + 1);
      expect(await prisma.liftRecord.count({ where: { userId: USER_PAGE_WRITE } })).toBe(0);
    });

    it('waits for a training-max edit holding its row, then saves the edited max', async () => {
      const counts = await apiCounts(USER_ROW_WRITE);

      const res = await clearDuring(USER_ROW_WRITE, counts, async (client) => {
        await client.query(`UPDATE "training_max" SET "weight" = 310 WHERE "userId" = $1`, [USER_ROW_WRITE]);
      });

      // Without the row locks, clear reads 300, saves it, and then deletes the 310 row.
      expect(res.statusCode).toBe(201);
      const snapshot = res.json<ClearTrainingDataResponse>().snapshot;
      expect((await inject(USER_ROW_WRITE, 'POST', `/users/me/snapshots/${snapshot.id}/restore`)).statusCode).toBe(200);
      expect((await prisma.trainingMax.findMany({ where: { userId: USER_ROW_WRITE } })).map((m) => m.weight)).toEqual([310]);
    });
  });

  it('keeps each user’s snapshots to themselves, and treats an expired one as gone', async () => {
    const snapshot = await clear(USER_ISOLATED);
    const url = `/users/me/snapshots/${snapshot.id}`;

    expect((await inject(USER_OTHER, 'GET', '/users/me/snapshots')).json()).toEqual([]);
    expect((await inject(USER_OTHER, 'POST', `${url}/restore`)).statusCode).toBe(404);
    expect((await inject(USER_OTHER, 'GET', `${url}/lift-records/parts`)).statusCode).toBe(404);
    expect((await inject(USER_OTHER, 'DELETE', url)).statusCode).toBe(404);
    expect(await asAppUser(USER_OTHER, (tx) => tx.dataSnapshot.count({ where: { id: snapshot.id } }))).toBe(0);
    await expect(
      asAppUser(USER_OTHER, (tx) =>
        tx.dataSnapshot.create({
          data: { userId: USER_ISOLATED, kind: 'clear', scope: {}, counts: {}, rows: Buffer.from([0]), expiresAt: day('2099-01-01') },
        }),
      ),
    ).rejects.toThrow();

    // Expired, the job hasn't run yet: the owner can't reach it either, and lifting_app's expiry
    // policies don't apply, so no other user sees it.
    await prisma.dataSnapshot.update({ where: { id: snapshot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await inject(USER_ISOLATED, 'GET', '/users/me/snapshots')).json()).toEqual([]);
    expect((await inject(USER_ISOLATED, 'POST', `${url}/restore`)).statusCode).toBe(404);
    expect((await inject(USER_ISOLATED, 'GET', `${url}/lift-records?part=1`)).statusCode).toBe(404);
    expect(await asAppUser(USER_OTHER, (tx) => tx.dataSnapshot.count({ where: { id: snapshot.id } }))).toBe(0);

    await prisma.dataSnapshot.update({ where: { id: snapshot.id }, data: { expiresAt: day('2099-01-01') } });
    expect((await inject(USER_ISOLATED, 'DELETE', url)).statusCode).toBe(204);
    expect(await prisma.dataSnapshot.count({ where: { id: snapshot.id } })).toBe(0);
  });

  it('keeps a snapshot of a kind this release doesn’t know from breaking the others (#1351)', async () => {
    // A later release writes a second kind (ADR-044) and is reverted: this code then reads its row.
    const known = await clear(USER_UNKNOWN_KIND);
    const unknown = await prisma.dataSnapshot.create({
      data: {
        userId: USER_UNKNOWN_KIND,
        // A kind no release writes yet; `overwrite` is read since #1182.
        kind: 'merge',
        scope: { programs: [] },
        counts: {},
        rows: Buffer.from([0]),
        expiresAt: day('2099-01-01'),
      },
    });

    const list = await inject(USER_UNKNOWN_KIND, 'GET', '/users/me/snapshots');
    expect(list.statusCode).toBe(200);
    expect(list.json<{ id: string }[]>().map((s) => s.id)).toEqual([known.id]);

    // The unknown row is never reached: restore and download answer as for a snapshot that isn't there.
    const unknownUrl = `/users/me/snapshots/${unknown.id}`;
    expect((await inject(USER_UNKNOWN_KIND, 'POST', `${unknownUrl}/restore`)).statusCode).toBe(404);
    expect((await inject(USER_UNKNOWN_KIND, 'GET', `${unknownUrl}/lift-records/parts`)).statusCode).toBe(404);
    expect((await inject(USER_UNKNOWN_KIND, 'GET', `${unknownUrl}/lift-records?part=1`)).statusCode).toBe(404);

    // The known snapshot still restores, and the unknown row is left as it was.
    expect((await inject(USER_UNKNOWN_KIND, 'POST', `/users/me/snapshots/${known.id}/restore`)).statusCode).toBe(200);
    expect(await prisma.dataSnapshot.count({ where: { id: unknown.id } })).toBe(1);
  });

  describe('the expiry job', () => {
    const IDS = {
      expiredA: '0e130900-0000-4000-8000-0000000000a1',
      keptA: '0e130900-0000-4000-8000-0000000000a2',
      expiredB: '0e130900-0000-4000-8000-0000000000b1',
      keptB: '0e130900-0000-4000-8000-0000000000b2',
    };

    /**
     * Runs the job inside a transaction that is rolled back, after `setup` (as the superuser) and
     * as `role`. `migration_owner` stands in for the migrator: it owns `data_snapshot` and is
     * neither a superuser nor BYPASSRLS, so forced row-level security binds it.
     */
    async function runJob(
      role: 'migration_owner' | 'lifting_app',
      setup: (client: Client) => Promise<void> = async () => {},
      timeZone = 'UTC',
    ) {
      const client = new Client({ connectionString: OWNER_URL });
      await client.connect();
      const log: ExpiryLogEntry[] = [];
      try {
        await client.query('BEGIN');
        // The session's zone, which must not move the expiry: `expiresAt` holds UTC wall-clock
        // time, as Prisma writes it. Two rows sit an hour either side of now, inside any offset.
        await client.query(`SELECT set_config('TimeZone', $1, true)`, [timeZone]);
        await client.query(
          `INSERT INTO "data_snapshot" ("id", "userId", "kind", "scope", "counts", "rows", "expiresAt") VALUES
             ($1, $5, 'clear', '{}', '{}', '\\x00', (now() AT TIME ZONE 'UTC') - interval '1 day'),
             ($2, $5, 'clear', '{}', '{}', '\\x00', (now() AT TIME ZONE 'UTC') + interval '1 hour'),
             ($3, $6, 'clear', '{}', '{}', '\\x00', (now() AT TIME ZONE 'UTC') - interval '1 hour'),
             ($4, $6, 'clear', '{}', '{}', '\\x00', (now() AT TIME ZONE 'UTC') + interval '29 days')`,
          [IDS.expiredA, IDS.keptA, IDS.expiredB, IDS.keptB, USER_CLEARED, USER_OTHER],
        );
        const expired = Number(
          (
            await client.query<{ n: string }>(
              `SELECT count(*) AS n FROM "data_snapshot" WHERE "expiresAt" <= (now() AT TIME ZONE 'UTC')`,
            )
          ).rows[0]?.n,
        );
        await client.query('CREATE ROLE "snapshot_migration_owner" NOSUPERUSER NOBYPASSRLS');
        await client.query('ALTER TABLE "data_snapshot" OWNER TO "snapshot_migration_owner"');
        await setup(client);
        await client.query(`SET LOCAL ROLE ${role === 'migration_owner' ? '"snapshot_migration_owner"' : 'lifting_app'}`);
        const exitCode = await runExpiryJob(client, (entry) => log.push(entry));
        await client.query('RESET ROLE');
        const left = (
          await client.query<{ id: string }>(`SELECT "id" FROM "data_snapshot" WHERE "id" = ANY($1) ORDER BY "id"`, [Object.values(IDS)])
        ).rows.map((r) => r.id);
        return { exitCode, log, left, expired };
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    }

    it.each(['UTC', 'Pacific/Auckland', 'America/New_York'])(
      'deletes every user’s expired snapshots as the migration role, keeps the rest, and logs the count (session zone %s)',
      async (timeZone) => {
        const { exitCode, log, left, expired } = await runJob('migration_owner', undefined, timeZone);

        expect(exitCode).toBe(0);
        expect(left).toEqual([IDS.keptA, IDS.keptB]);
        expect(expired).toBeGreaterThanOrEqual(2);
        expect(log).toEqual([{ severity: 'INFO', message: 'Expired snapshots deleted (#1309)', deleted: expired, remaining: 0 }]);
      },
    );

    it('fails when an expired snapshot is left', async () => {
      const { exitCode, log, left, expired } = await runJob('migration_owner', async (client) => {
        await client.query('DROP POLICY "data_snapshot_expired_delete" ON "data_snapshot"');
      });

      expect(exitCode).toBe(1);
      expect(left).toEqual(Object.values(IDS).sort());
      expect(log).toEqual([
        { severity: 'ERROR', message: 'Snapshot expiry left expired snapshots behind (#1309)', deleted: 0, remaining: expired },
      ]);
    });

    it('refuses to run as any role but the table’s owner', async () => {
      const { exitCode, log, left } = await runJob('lifting_app');

      expect(exitCode).toBe(1);
      expect(left).toEqual(Object.values(IDS).sort());
      expect(log).toEqual([expect.objectContaining({ severity: 'ERROR', role: 'lifting_app', owner: 'snapshot_migration_owner' })]);
    });
  });
});
