// Real-Postgres E2E for #1160: a Smart Import dry run must refuse what its commit refuses. The
// in-memory adapters accept a fraction in an integer column and have no program owners, so the
// parity tests in import.e2e.spec.ts can't see a Prisma write failing on either.
//
// Postgres comes from jest.global-setup.js. Seeding, cleanup and the row reads use the owner;
// every request runs as lifting_app, under forced row-level security.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
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
jest.setTimeout(DB_E2E_HOOK_TIMEOUT_MS);

const USER = 'import-dry-run-parity-db';
const OTHER_USER = 'import-dry-run-parity-db-other';
const USERS = [USER, OTHER_USER];

const LIFT_HEADER = 'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes';
const SPEC_HEADER = 'Week,Offset,Lift,Increment,Order,Sets,Reps,AMRAP?,Warm-Up %,WT Decrement %,Activation';
const SPEC_ROW = '1,0,Bench P.,2.5,1,3,8,TRUE,.6,0.05,Band Flye';
const SPEC_CSV = [SPEC_HEADER, SPEC_ROW].join('\n');

async function cleanup(owner: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await owner.liftRecord.deleteMany({ where });
  await owner.importBatch.deleteMany({ where });
  // Cascades to the programs' spec rows.
  await owner.customProgram.deleteMany({ where });
}

describeOrSkip('import dry run and commit agree (#1160, e2e, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let programId = '';
  let otherProgramId = '';
  const FLAG = 'IMPORT_ASSIGN_ENABLED';
  const savedFlag = process.env[FLAG];

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanup(owner);
    programId = (await owner.customProgram.create({ data: { userId: USER, name: 'Parity program' } })).id;
    otherProgramId = (await owner.customProgram.create({ data: { userId: OTHER_USER, name: 'Not yours' } })).id;
    process.env.DATABASE_URL = APP_DB_URL;
    // The plain commit path, which a file with no Assign breakdown takes either way.
    delete process.env[FLAG];
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

  const importCsv = (program: string, csv: string, query: string) => {
    const boundary = '----ParityDbBoundary';
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/programs/${encodeURIComponent(program)}/import${query}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${USER}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="upload.csv"',
        'Content-Type: text/csv',
        '',
        csv,
        `--${boundary}--`,
      ].join('\r\n'),
    });
  };

  /** Dry-runs, then commits, one file, and expects both to give `status` with the same body. */
  async function expectSameRefusal(program: string, csv: string, destination: string, status: number) {
    const dryRun = await importCsv(program, csv, `?mode=dry-run&destination=${destination}`);
    const commit = await importCsv(program, csv, `?mode=commit&destination=${destination}`);
    expect({ dryRun: dryRun.statusCode, commit: commit.statusCode }).toEqual({ dryRun: status, commit: status });
    expect(dryRun.json()).toEqual(commit.json());
    return dryRun.json<{ errors?: Array<{ row: number; field?: string }> }>();
  }

  it.each([
    ['Reps', 'reps', '5-3-1,1,1,2026-01-01,Bench P.,2,180,5.5,'],
    ['Set #', 'setNum', '5-3-1,1,1,2026-01-01,Bench P.,1.5,180,5,'],
    ['Workout #', 'workoutNum', '5-3-1,1,1.5,2026-01-01,Bench P.,2,180,5,'],
  ])('a lift record with a fractional %s is a row error from both, and nothing is written', async (_label, field, row) => {
    const csv = [LIFT_HEADER, '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,', row].join('\n');
    const body = await expectSameRefusal('5-3-1', csv, 'lift-records', 400);
    expect(body.errors).toEqual([expect.objectContaining({ row: 2, field })]);
    expect(await owner.liftRecord.count({ where: { userId: USER } })).toBe(0);
  });

  it.each([
    ['Sets', 'sets', '1,0,Squat,5,2,2.5,8,TRUE,.6,0.05,'],
    ['Reps', 'reps', '1,0,Squat,5,2,3,7.5,TRUE,.6,0.05,'],
    ['Order', 'order', '1,0,Squat,5,2.5,3,8,TRUE,.6,0.05,'],
  ])('a program-spec row with a fractional %s is a row error from both, and nothing is written', async (_label, field, row) => {
    const csv = [SPEC_HEADER, SPEC_ROW, row].join('\n');
    const body = await expectSameRefusal(programId, csv, 'program-spec', 400);
    expect(body.errors).toEqual([expect.objectContaining({ row: 2, field })]);
    expect(await owner.customProgramSpec.count({ where: { programId } })).toBe(0);
  });

  it('a program-spec dry run to a built-in program is refused as the commit is', async () => {
    await expectSameRefusal('5-3-1', SPEC_CSV, 'program-spec', 400);
  });

  it("a program-spec dry run to another lifter's program is not found, as the commit is", async () => {
    await expectSameRefusal(otherProgramId, SPEC_CSV, 'program-spec', 404);
    expect(await owner.customProgramSpec.count({ where: { programId: otherProgramId } })).toBe(0);
  });

  it('a program-spec dry run to your own program still reports its counts', async () => {
    const dryRun = await importCsv(programId, SPEC_CSV, '?mode=dry-run&destination=program-spec');
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json()).toMatchObject({ destination: 'program-spec', created: 1, updated: 0, skipped: 0 });
  });
});
