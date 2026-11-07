// Real-Postgres E2E for Download My Data (#947). As in lift-modification.db.e2e.spec.ts, `app`
// boots against the restricted lifting_app role, so these requests run through RlsInterceptor and
// forced row-level security, and `prisma` is the owner connection, used only to seed and clean up
// across synthetic users. The in-memory suite covers auth, the empty account and logging.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { Prisma, PrismaClient } from '@prisma/client';
import { strFromU8, unzipSync } from 'fflate';
import type { ImportKind, ImportPreviewResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { UserDataRows } from '../ports/IUserDataExportRepository';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

// See programs.db.e2e.spec.ts (#567): headroom for a contended full-suite Windows run.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_OWNER = 'db-e2e-export';
const USER_OTHER = 'db-e2e-export-other';
const USER_IMPORT = 'db-e2e-export-import';
const USERS = [USER_OWNER, USER_OTHER, USER_IMPORT];
const ACTIVE_PROGRAM = '5-3-1';
const SECOND_PROGRAM = 'rpt';
const OWNER_PROGRAM_ID = '0e947000-0000-4000-8000-000000000001';
const OTHER_PROGRAM_ID = '0e947000-0000-4000-8000-000000000002';
const IMPORT_PROGRAM_ID = '0e947000-0000-4000-8000-000000000003';
// In every row seeded for USER_OTHER, so a leak of any of its tables shows up in the archive.
const OTHER_MARK = 'other-user-marker';

/**
 * Each user-scoped model, and where `logbook.json` keeps it. Read against the live schema below,
 * so a new table fails this suite until the export covers it. A model listed here but seeded with
 * no rows fails too.
 */
const LOGBOOK_KEYS: Record<string, keyof UserDataRows | 'customProgramSpecs'> = {
  LiftRecord: 'liftRecords',
  TrainingMax: 'trainingMaxes',
  MacrocycleDashboard: 'macrocycleDashboards',
  TrainingMaxHistory: 'trainingMaxHistory',
  BodyWeight: 'bodyWeights',
  StrengthGoal: 'strengthGoals',
  WorkoutDateOverride: 'workoutDateOverrides',
  WorkoutSkipOverride: 'workoutSkipOverrides',
  WorkoutLiftOverride: 'workoutLiftOverrides',
  LiftMetadata: 'liftMetadata',
  CustomLift: 'customLifts',
  LiftModification: 'liftModifications',
  UserSettings: 'userSettings',
  FocusBlock: 'focusBlocks',
  FocusDayState: 'focusDayStates',
  MacrocycleScheduledWorkout: 'macrocycleScheduledWorkouts',
  CustomProgram: 'customPrograms',
  CustomProgramSpec: 'customProgramSpecs',
};
// Internal undo state for an import, not the user's data.
const NOT_EXPORTED = ['ImportBatch'];

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallbacks never run (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_DATABASE_URL ?? '';

const DAY = new Date('2026-01-05T00:00:00.000Z');

async function cleanUsers(prisma: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await prisma.liftRecord.deleteMany({ where });
  await prisma.trainingMax.deleteMany({ where });
  await prisma.macrocycleDashboard.deleteMany({ where });
  await prisma.trainingMaxHistory.deleteMany({ where });
  await prisma.bodyWeight.deleteMany({ where });
  await prisma.strengthGoal.deleteMany({ where });
  await prisma.workoutDateOverride.deleteMany({ where });
  await prisma.workoutSkipOverride.deleteMany({ where });
  await prisma.workoutLiftOverride.deleteMany({ where });
  await prisma.liftMetadata.deleteMany({ where });
  await prisma.customLift.deleteMany({ where });
  await prisma.liftModification.deleteMany({ where });
  await prisma.userSettings.deleteMany({ where });
  await prisma.focusBlock.deleteMany({ where });
  await prisma.focusDayState.deleteMany({ where });
  await prisma.macrocycleScheduledWorkout.deleteMany({ where });
  await prisma.customProgram.deleteMany({ where });
  await prisma.importBatch.deleteMany({ where });
}

/** One row in every user-scoped table. `mark` lands in a text column of each. */
async function seedUser(
  prisma: PrismaClient,
  userId: string,
  mark: string,
  customProgramId: string,
): Promise<void> {
  const program = ACTIVE_PROGRAM;
  const workout = { userId, program, macrocycleNum: 1, workoutNum: 1 };
  const sets = (lift: string, weight: number) => ({
    ...workout,
    date: DAY,
    lift,
    setNum: 1,
    weight,
    reps: 5,
    notes: mark,
  });
  await prisma.liftRecord.createMany({
    data: [
      sets('Squat', 200),
      sets('Bench Press', 150),
      { ...sets('Bench Press', 140), occurrence: 1 },
      { ...sets('Squat', 180), program: SECOND_PROGRAM },
    ],
  });
  await prisma.trainingMax.createMany({
    data: [
      { userId, program, lift: 'Squat', weight: 300, dateUpdated: DAY },
      { userId, program, lift: 'Bench Press', weight: 200, dateUpdated: DAY },
      { userId, program: SECOND_PROGRAM, lift: 'Squat', weight: 280, dateUpdated: DAY },
    ],
  });
  await prisma.macrocycleDashboard.create({
    data: {
      userId,
      program,
      macrocycleUnit: 'month',
      macrocycleNum: 1,
      macrocycleDate: DAY,
      sheetName: mark,
      macrocycleStartWeekday: 'Monday',
    },
  });
  await prisma.trainingMaxHistory.create({
    data: { userId, program, lift: mark, weight: 300, date: DAY, source: 'test' },
  });
  await prisma.bodyWeight.create({ data: { userId, program: mark, date: DAY, weight: 180, unit: 'lbs' } });
  await prisma.strengthGoal.createMany({
    data: [
      { userId, program, lift: 'Squat', goalType: 'absolute', target: 400, unit: 'lbs' },
      { userId, program, lift: 'Bench Press', goalType: 'relative', ratio: 1.5, unit: 'kg' },
    ],
  });
  await prisma.workoutDateOverride.create({ data: { ...workout, newDate: DAY } });
  await prisma.workoutSkipOverride.create({ data: { ...workout, reason: mark } });
  await prisma.workoutLiftOverride.create({ data: { ...workout, lift: 'Squat', action: mark } });
  await prisma.liftMetadata.create({
    data: { userId, lift: 'Squat', muscleGroups: [mark], substitutions: [] },
  });
  await prisma.customLift.create({
    data: { userId, name: `${mark} press`, classification: 'accessory', patterns: [], jointActions: [] },
  });
  await prisma.liftModification.create({ data: { userId, lift: 'bench-press', name: mark } });
  await prisma.userSettings.create({ data: { userId, activeProgram: program } });
  await prisma.focusBlock.create({
    data: {
      userId,
      series: mark,
      area: 'Biceps',
      period: 'monthly',
      align: 'calendar',
      start: DAY,
      selection: 'rules',
      overlap: 'swap',
      progression: 'double',
      priority: 1,
      timer: {},
      onEnd: 'prompt',
      pool: [],
    },
  });
  await prisma.focusDayState.create({ data: { ...workout, state: { mark } } });
  await prisma.macrocycleScheduledWorkout.create({ data: { ...workout, weekNum: 1, scheduledDate: DAY } });
  await prisma.customProgram.create({
    data: {
      id: customProgramId,
      userId,
      name: `${mark} plan`,
      specs: {
        create: {
          week: 1,
          lift: 'Squat',
          increment: 5,
          order: 1,
          sets: 3,
          reps: 5,
          warmUpPct: '.5',
          wtDecrementPct: 0,
          activation: mark,
        },
      },
    },
  });
}

describeOrSkip('Download My Data HTTP (e2e, PrismaRepositoryFactory)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  let files: Record<string, string>;
  let logbook: { schemaVersion: number; exportedAt: string; tables: Record<string, unknown> };

  const upload = (
    user: string,
    program: string,
    mode: 'preview' | 'commit',
    csv: string,
    destination: ImportKind,
  ) => {
    const boundary = '----DataExportBoundary';
    const query = mode === 'commit' ? `?mode=commit&destination=${destination}` : '?mode=preview';
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/programs/${program}/import${query}`,
        headers: {
          authorization: `Bearer ${user}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: [
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="upload.csv"',
          'Content-Type: text/csv',
          '',
          csv,
          `--${boundary}--`,
          '',
        ].join('\r\n'),
      });
  };

  beforeAll(async () => {
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
    prisma = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanUsers(prisma);
    await seedUser(prisma, USER_OWNER, 'owner-marker', OWNER_PROGRAM_ID);
    await seedUser(prisma, USER_OTHER, OTHER_MARK, OTHER_PROGRAM_ID);
    await prisma.customProgram.create({
      data: { id: IMPORT_PROGRAM_ID, userId: USER_IMPORT, name: 'import target' },
    });
    // Non-empty, as the acceptance criterion asks: the importing account already has its own rows.
    await prisma.liftRecord.create({
      data: {
        userId: USER_IMPORT,
        program: ACTIVE_PROGRAM,
        macrocycleNum: 9,
        workoutNum: 1,
        date: DAY,
        lift: 'Deadlift',
        setNum: 1,
        weight: 300,
        reps: 3,
      },
    });
    await prisma.trainingMax.create({
      data: { userId: USER_IMPORT, program: ACTIVE_PROGRAM, lift: 'Deadlift', weight: 350, dateUpdated: DAY },
    });

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(multipart as any, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/users/me/export', headers: { authorization: `Bearer ${USER_OWNER}` } });
    expect(res.statusCode).toBe(200);
    files = Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(res.rawPayload))).map(([path, bytes]) => [path, strFromU8(bytes)]),
    );
    logbook = JSON.parse(files['logbook.json']!);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await cleanUsers(prisma).catch(() => undefined);
    await prisma?.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('runs as the restricted role, not the owner', async () => {
    expect(APP_ROLE_URL).not.toBe(OWNER_DATABASE_URL);
    expect(new URL(APP_ROLE_URL ?? '').username).toBe('lifting_app');
  });

  it('accounts for every model in the schema', () => {
    const models = Prisma.dmmf.datamodel.models.map((model) => model.name).sort();
    expect(models).toEqual([...Object.keys(LOGBOOK_KEYS), ...NOT_EXPORTED].sort());
  });

  it.each(Object.entries(LOGBOOK_KEYS))('keeps %s in logbook.json as %s', (_model, key) => {
    const table =
      key === 'customProgramSpecs'
        ? (logbook.tables['customPrograms'] as { specs: unknown[] }[])[0]?.specs
        : logbook.tables[key];
    const rows = Array.isArray(table) ? table : [table];
    expect(rows.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('never shows another user, in any file', () => {
    const paths = Object.keys(files);
    expect(paths.length).toBeGreaterThanOrEqual(5);
    for (const path of paths) {
      expect(files[path]).not.toContain(OTHER_MARK);
      expect(files[path]).not.toContain(OTHER_PROGRAM_ID);
      expect(files[path]).not.toContain(USER_OTHER);
    }
    expect(files['logbook.json']).toContain('owner-marker');
  });

  it('leaves the user id out of logbook.json', () => {
    expect(files['logbook.json']).not.toContain(USER_OWNER);
    expect(files['logbook.json']).not.toContain('"userId"');
  });

  it('writes the second program and the custom program to their own folders', () => {
    expect(files[`other-programs/${SECOND_PROGRAM}/training-maxes.csv`]).toContain('280');
    expect(files[`other-programs/owner-marker-plan-${OWNER_PROGRAM_ID.slice(0, 8)}/program-spec.csv`]).toContain(
      'Squat',
    );
  });

  describe.each<[string, ImportKind, () => string, string]>([
    ['lift-records.csv', 'lift-records', () => files['lift-records.csv']!, ACTIVE_PROGRAM],
    ['training-maxes.csv', 'training-maxes', () => files['training-maxes.csv']!, ACTIVE_PROGRAM],
    ['strength-goals.csv', 'strength-goals', () => files['strength-goals.csv']!, ACTIVE_PROGRAM],
    [
      'program-spec.csv',
      'program-spec',
      () => files[`other-programs/owner-marker-plan-${OWNER_PROGRAM_ID.slice(0, 8)}/program-spec.csv`]!,
      IMPORT_PROGRAM_ID,
    ],
  ])('%s on a non-empty account', (_file, kind, csv, program) => {
    it('classifies itself and validates with no errors', async () => {
      const res = await upload(USER_IMPORT, program, 'preview', csv(), kind);
      expect(res.statusCode).toBe(200);
      const preview = res.json() as ImportPreviewResponse;
      // `type` is only set when the classifier clears its auto-accept threshold.
      expect(preview.classification.type).toBe(kind);
      expect(preview.destination).toBe(kind);
      expect(preview.errors).toEqual([]);
    });

    it('commits', async () => {
      const res = await upload(USER_IMPORT, program, 'commit', csv(), kind);
      expect(res.statusCode).toBe(200);
    });
  });

  it('restored the relative goal and the goal in kg as they were', async () => {
    // The import stores a built-in lift under its catalog id, whatever the file spelled it.
    const goal = await prisma.strengthGoal.findUnique({
      where: { userId_program_lift: { userId: USER_IMPORT, program: ACTIVE_PROGRAM, lift: 'bench-press' } },
    });
    expect(goal).toMatchObject({ goalType: 'relative', ratio: 1.5, unit: 'kg' });
  });
});
