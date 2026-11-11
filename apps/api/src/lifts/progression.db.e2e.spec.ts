// Real-Postgres E2E suite for progression storage (#1210, phase 2 of #1206; ADR-043).
// Postgres is provisioned by jest.global-setup.js. As in lift-modification.db.e2e.spec.ts:
//   - `app` boots against the restricted lifting_app role, so every HTTP assertion below runs
//     through RlsInterceptor and forced row-level security, as production does;
//   - `owner` is the owner connection, used to seed and clean up across synthetic users, and to
//     run the backfill migration the way the migrate job does.
// That one user can't read another's values is proven in rls.db.e2e.spec.ts.
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { CustomProgramResponse, LiftMetadataResponse, UserSettingsResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

// See programs.db.e2e.spec.ts (#567): headroom for a contended full-suite Windows run.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER = 'db-e2e-progression';
const USER_BACKFILL = 'db-e2e-progression-backfill';
const USERS = [USER, USER_BACKFILL];

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallbacks never run (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_DATABASE_URL ?? '';

const BACKFILL_SQL = join(
  __dirname,
  '../../prisma/migrations/20261111000001_backfill_custom_spec_progression/migration.sql',
);

const SPEC_ROW = {
  week: 1,
  offset: 0,
  increment: 5,
  sets: 3,
  reps: 12,
  amrap: false,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0,
  activation: 'compound',
};

async function cleanUsers(prisma: PrismaClient): Promise<void> {
  await prisma.liftMetadata.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.userSettings.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.customLift.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.customProgram.deleteMany({ where: { userId: { in: USERS } } });
}

class Rollback extends Error {}

describeOrSkip('Progression storage HTTP (e2e, PrismaRepositoryFactory)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;

  const call = (method: string, url: string, body?: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: method as 'GET',
      url,
      headers:
        body === undefined
          ? { authorization: `Bearer ${USER}` }
          : { 'content-type': 'application/json', authorization: `Bearer ${USER}` },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanUsers(owner);

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await cleanUsers(owner).catch(() => undefined);
    await owner?.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanUsers(owner);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  describe("a lift's own progression", () => {
    it('writes, reads and clears it on a built-in lift', async () => {
      const patched = await call('PATCH', '/lifts/Squat/metadata', {
        progression: 'linear',
        progressionIncrement: 5,
        repsHigh: 5,
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ progression: 'linear', progressionIncrement: 5, repsLow: null, repsHigh: 5 });

      const read = (await call('GET', '/lifts/Squat/metadata')).json() as LiftMetadataResponse;
      expect(read).toMatchObject({ progression: 'linear', progressionIncrement: 5, repsLow: null, repsHigh: 5 });
      const row = await owner.liftMetadata.findUniqueOrThrow({ where: { userId_lift: { userId: USER, lift: 'Squat' } } });
      expect(row).toMatchObject({ progression: 'linear', progressionIncrement: 5, repsHigh: 5 });

      // Leaving a field out keeps it; null clears it.
      await call('PATCH', '/lifts/Squat/metadata', { foundational: true });
      expect((await call('GET', '/lifts/Squat/metadata')).json()).toMatchObject({ progression: 'linear', foundational: true });
      await call('PATCH', '/lifts/Squat/metadata', { progression: null, progressionIncrement: null, repsHigh: null });
      expect((await call('GET', '/lifts/Squat/metadata')).json()).toMatchObject({
        progression: null,
        progressionIncrement: null,
        repsLow: null,
        repsHigh: null,
        foundational: true,
      });
    });

    it('writes and reads it on a custom lift', async () => {
      const created = await call('POST', '/lifts/custom', { name: 'Machine Preacher Curl', classification: 'accessory' });
      expect(created.statusCode).toBe(201);

      const url = `/lifts/${encodeURIComponent('Machine Preacher Curl')}/metadata`;
      const patched = await call('PATCH', url, { progression: 'double', progressionIncrement: 2.5, repsLow: 8, repsHigh: 12 });
      expect(patched.statusCode).toBe(200);
      expect((await call('GET', url)).json()).toMatchObject({
        lift: 'Machine Preacher Curl',
        progression: 'double',
        progressionIncrement: 2.5,
        repsLow: 8,
        repsHigh: 12,
      });
    });

    it.each([
      ['an unknown type', { progression: 'wave' }],
      ['rpe, not selectable on a lift', { progression: 'rpe' }],
      ['repsLow above repsHigh', { progression: 'double', repsLow: 12, repsHigh: 8 }],
      ['a zero increment', { progressionIncrement: 0 }],
      ['fractional reps', { repsHigh: 8.5 }],
    ])('rejects %s with a 400 and stores nothing', async (_name, body) => {
      expect((await call('PATCH', '/lifts/Squat/metadata', body)).statusCode).toBe(400);
      expect(await owner.liftMetadata.count({ where: { userId: USER } })).toBe(0);
    });

    it('rejects one end of a range that would cross the stored other end', async () => {
      await call('PATCH', '/lifts/Squat/metadata', { progression: 'double', repsLow: 8, repsHigh: 12 });
      expect((await call('PATCH', '/lifts/Squat/metadata', { repsLow: 13 })).statusCode).toBe(400);
      expect((await call('PATCH', '/lifts/Squat/metadata', { repsHigh: 7 })).statusCode).toBe(400);
      // Clearing one end can't cross anything.
      expect((await call('PATCH', '/lifts/Squat/metadata', { repsHigh: null })).statusCode).toBe(200);
      expect((await call('PATCH', '/lifts/Squat/metadata', { repsLow: 20 })).statusCode).toBe(200);
    });
  });

  describe("the lifter's default progression", () => {
    it('is unset for a new lifter, then sets, replaces and clears', async () => {
      expect(((await call('GET', '/users/me/settings')).json() as UserSettingsResponse).defaultProgression).toBeNull();

      const set = await call('PATCH', '/users/me/settings', {
        defaultProgression: { type: 'double', increment: 2.5, repsLow: 8, repsHigh: 12 },
      });
      expect(set.statusCode).toBe(200);
      expect((await call('GET', '/users/me/settings')).json()).toMatchObject({
        defaultProgression: { type: 'double', increment: 2.5, repsLow: 8, repsHigh: 12 },
      });

      // Replaced whole: the old range doesn't survive a default that names none.
      await call('PATCH', '/users/me/settings', { defaultProgression: { type: 'linear' } });
      expect((await call('GET', '/users/me/settings')).json()).toMatchObject({
        defaultProgression: { type: 'linear', increment: null, repsLow: null, repsHigh: null },
      });

      // Another setting leaves it alone; null clears it.
      await call('PATCH', '/users/me/settings', { unit: 'kg' });
      expect(((await call('GET', '/users/me/settings')).json() as UserSettingsResponse).defaultProgression).toMatchObject({
        type: 'linear',
      });
      expect((await call('PATCH', '/users/me/settings', { defaultProgression: null })).statusCode).toBe(200);
      expect(((await call('GET', '/users/me/settings')).json() as UserSettingsResponse).defaultProgression).toBeNull();
      expect(await owner.userSettings.findUniqueOrThrow({ where: { userId: USER } })).toMatchObject({
        defaultProgression: null,
        defaultProgressionIncrement: null,
        defaultProgressionRepsLow: null,
        defaultProgressionRepsHigh: null,
      });
    });

    it.each([
      ['an unknown type', { type: 'wave' }],
      ['rpe', { type: 'rpe' }],
      ['no type', { increment: 5 }],
      ['repsLow above repsHigh', { type: 'double', repsLow: 12, repsHigh: 8 }],
      ['a primitive', 'linear'],
    ])('rejects %s with a 400', async (_name, defaultProgression) => {
      expect((await call('PATCH', '/users/me/settings', { defaultProgression })).statusCode).toBe(400);
      expect(await owner.userSettings.count({ where: { userId: USER } })).toBe(0);
    });
  });

  describe("a custom program row's override", () => {
    it('stores the override and repsLow, and leaves a row without one null', async () => {
      const res = await call('POST', '/programs/custom', {
        name: 'Progression rows',
        specs: [
          { ...SPEC_ROW, lift: 'Cable Curl', order: 1, progression: 'double', repsLow: 8 },
          { ...SPEC_ROW, lift: 'Squat', order: 2 },
        ],
      });
      expect(res.statusCode).toBe(201);
      const program = res.json() as CustomProgramResponse;
      const curl = program.specs.find((s) => s.lift === 'Cable Curl');
      const squat = program.specs.find((s) => s.lift === 'Squat');
      expect(curl).toMatchObject({ progression: 'double', repsLow: 8, reps: 12 });
      expect(squat).not.toHaveProperty('progression');

      const rows = await owner.customProgramSpec.findMany({ where: { programId: program.id }, orderBy: { order: 'asc' } });
      expect(rows.map((r) => [r.lift, r.progression, r.repsLow])).toEqual([
        ['Cable Curl', 'double', 8],
        ['Squat', null, null],
      ]);
    });

    it('keeps a stored override when a save leaves it out, and clears it on null', async () => {
      const created = await call('POST', '/programs/custom', {
        name: 'Kept rows',
        specs: [
          { ...SPEC_ROW, lift: 'Cable Curl', order: 1, progression: 'amrap_gated' },
          { ...SPEC_ROW, lift: 'Squat', order: 2, progression: 'double', repsLow: 8 },
        ],
      });
      expect(created.statusCode).toBe(201);
      const { id } = created.json() as CustomProgramResponse;
      const stored = async () =>
        (await owner.customProgramSpec.findMany({ where: { programId: id }, orderBy: { order: 'asc' } })).map(
          (r) => [r.lift, r.progression, r.repsLow],
        );

      // A client that doesn't know the fields (an older web bundle) saves the same rows.
      const omitted = await call('PUT', `/programs/custom/${id}`, {
        specs: [
          { ...SPEC_ROW, lift: 'Cable Curl', order: 1, sets: 4 },
          { ...SPEC_ROW, lift: 'Squat', order: 2 },
        ],
      });
      expect(omitted.statusCode).toBe(200);
      expect(await stored()).toEqual([
        ['Cable Curl', 'amrap_gated', null],
        ['Squat', 'double', 8],
      ]);

      const cleared = await call('PUT', `/programs/custom/${id}`, {
        specs: [
          { ...SPEC_ROW, lift: 'Cable Curl', order: 1, progression: null },
          { ...SPEC_ROW, lift: 'Squat', order: 2, repsLow: null },
        ],
      });
      expect(cleared.statusCode).toBe(200);
      expect(await stored()).toEqual([
        ['Cable Curl', null, null],
        ['Squat', 'double', null],
      ]);
    });

    it('clears a kept repsLow once the row reps falls below it', async () => {
      const created = await call('POST', '/programs/custom', {
        name: 'Lowered reps',
        specs: [{ ...SPEC_ROW, lift: 'Cable Curl', order: 1, progression: 'double', repsLow: 8 }],
      });
      expect(created.statusCode).toBe(201);
      const { id } = created.json() as CustomProgramResponse;

      // `repsLow` left out, as by a client that predates it, with `reps` now below the stored 8.
      const res = await call('PUT', `/programs/custom/${id}`, {
        specs: [{ ...SPEC_ROW, lift: 'Cable Curl', order: 1, reps: 6 }],
      });
      expect(res.statusCode).toBe(200);
      const [row] = await owner.customProgramSpec.findMany({ where: { programId: id } });
      expect([row?.reps, row?.progression, row?.repsLow]).toEqual([6, 'double', null]);
    });

    it.each([
      ['rpe', { progression: 'rpe' }],
      ['repsLow above reps', { repsLow: 13 }],
    ])('rejects a row with %s with a 400', async (_name, override) => {
      const res = await call('POST', '/programs/custom', {
        name: 'Bad row',
        specs: [{ ...SPEC_ROW, lift: 'Cable Curl', order: 1, ...override }],
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('the backfill migration', () => {
    // Runs the shipped SQL as the owner, as the migrate job does, inside a transaction that is
    // always rolled back: the UPDATE reaches every user's rows, so committing it would change
    // rows another suite running against the same database left null on purpose.
    // Prisma runs one statement per call, so the file is split on `;` once its comments go.
    const backfillStatements = (): string[] =>
      readFileSync(BACKFILL_SQL, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);

    async function withBackfill(body: (tx: PrismaClient) => Promise<void>): Promise<void> {
      const statements = backfillStatements();
      expect(statements.some((s) => s.startsWith('UPDATE'))).toBe(true);
      try {
        await owner.$transaction(
          async (tx) => {
            // The file's 5s lock timeout suits the migrate job, which has the database to itself.
            // Here other suites may hold a row the UPDATE needs for a moment, so wait longer, but
            // less than the transaction's own timeout, so a long wait fails as a lock timeout.
            for (const statement of statements) {
              await tx.$executeRawUnsafe(
                /^SET LOCAL lock_timeout/i.test(statement) ? "SET LOCAL lock_timeout = '20s'" : statement,
              );
            }
            await body(tx as unknown as PrismaClient);
            throw new Rollback();
          },
          { timeout: DB_E2E_HOOK_TIMEOUT_MS },
        );
      } catch (err) {
        // A failed assertion surfaces as itself, with its diff.
        if (err instanceof Rollback) return;
        throw err;
      }
      throw new Error('the backfill transaction committed');
    }

    it('tags every pre-existing row amrap_gated, keeps a set value, and changes nothing on a second run', async () => {
      // Rows as they stood before the column existed: progression null.
      const program = await owner.customProgram.create({
        data: {
          userId: USER_BACKFILL,
          name: 'Pre-existing program',
          specs: {
            create: [
              { ...SPEC_ROW, lift: 'Bench Press', order: 1 },
              { ...SPEC_ROW, lift: 'Squat', order: 2 },
              { ...SPEC_ROW, week: 2, lift: 'Squat', order: 1 },
              { ...SPEC_ROW, lift: 'Cable Curl', order: 3, progression: 'double', repsLow: 8 },
            ],
          },
        },
      });

      await withBackfill(async (tx) => {
        const rows = await tx.customProgramSpec.findMany({
          where: { programId: program.id },
          orderBy: [{ week: 'asc' }, { order: 'asc' }],
        });
        expect(rows.map((r) => [r.lift, r.progression])).toEqual([
          ['Bench Press', 'amrap_gated'],
          ['Squat', 'amrap_gated'],
          ['Cable Curl', 'double'],
          ['Squat', 'amrap_gated'],
        ]);
        // A second run leaves this program's rows as they are. The check reads the rows rather
        // than the statement's count, which covers the whole table: another suite can commit a
        // null row between the two runs.
        const update = backfillStatements().find((s) => s.startsWith('UPDATE')) ?? '';
        await tx.$executeRawUnsafe(update);
        const again = await tx.customProgramSpec.findMany({
          where: { programId: program.id },
          orderBy: [{ week: 'asc' }, { order: 'asc' }],
        });
        expect(again).toEqual(rows);
      });

      // Rolled back: the seeded rows are as they were.
      expect(await owner.customProgramSpec.count({ where: { programId: program.id, progression: null } })).toBe(3);
      // Room for the transaction's full timeout, so Jest doesn't abandon it with its locks held.
    }, DB_E2E_HOOK_TIMEOUT_MS * 2);
  });
});
