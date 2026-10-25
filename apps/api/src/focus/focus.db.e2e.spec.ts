// Real-Postgres E2E suite for focus work (#1056). Postgres is provisioned by
// jest.global-setup.js, which exposes LIFTING_TC_DATABASE_URL (the restricted lifting_app
// role) and LIFTING_TC_OWNER_DATABASE_URL (the owner). As in programs.db.e2e.spec.ts:
//   - `app` boots against the restricted role, so every HTTP assertion below runs through
//     RlsInterceptor and the focus tables' forced row-level security, as production does;
//   - `prisma` is the owner connection, used only to clean up, seed lift records and
//     assert stored rows across synthetic users.
// The row-level-security policies themselves are proven in rls.db.e2e.spec.ts.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { defaultFocusPool, defaultPoolEntry } from '@lifting-logbook/core';
import {
  FocusBlockResponse,
  FocusBlockSummaryResponse,
  FocusDayPlanResponse,
  FocusDayState,
  FocusPoolEntry,
  emptyFocusDayState,
} from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';

// See programs.db.e2e.spec.ts (#567): headroom for a contended full-suite Windows run.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_OWNER = 'db-e2e-focus';
const USER_OTHER = 'db-e2e-focus-other';
const USERS = [USER_OWNER, USER_OTHER];
const PROGRAM = '5-3-1';
const TODAY = '2026-10-25';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallback never runs (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_DATABASE_URL ?? '';

function entry(lift: string, overrides: Partial<FocusPoolEntry> = {}): FocusPoolEntry {
  return { ...defaultPoolEntry(lift), ...overrides };
}

function blockBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    area: 'Biceps',
    period: 'monthly',
    align: 'calendar',
    start: '2026-10-01',
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    timer: { prep: 10, set: 40, rest: 60 },
    onEnd: 'prompt',
    nextArea: null,
    pool: [entry('Hammer Curl', { lastReps: [12, 11, 10] }), entry('Incline DB Curl')],
    ...overrides,
  };
}

async function cleanUsers(prisma: PrismaClient): Promise<void> {
  await prisma.focusBlock.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.focusDayState.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.userSettings.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.liftRecord.deleteMany({ where: { userId: { in: USERS } } });
}

describeOrSkip('Focus work HTTP (e2e, PrismaRepositoryFactory)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  const as = (user: string) => (method: string, url: string, body?: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: method as 'GET',
      url,
      headers:
        body === undefined
          ? { authorization: `Bearer ${user}` }
          : { 'content-type': 'application/json', authorization: `Bearer ${user}` },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const owner = as(USER_OWNER);
  const other = as(USER_OTHER);

  beforeAll(async () => {
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
    prisma = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanUsers(prisma);

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

  let blockId = '';

  it('POST /focus/blocks stores the block, with its pool and timer as JSON', async () => {
    const res = await owner('POST', `/focus/blocks?today=${TODAY}`, blockBody());
    expect(res.statusCode).toBe(201);
    const block = res.json() as FocusBlockResponse;
    blockId = block.id;
    expect(block).toMatchObject({ status: 'active', rangeStart: '2026-10-01', rangeEnd: '2026-10-31', priority: 1 });

    const row = await prisma.focusBlock.findUnique({ where: { id: blockId } });
    expect(row?.userId).toBe(USER_OWNER);
    expect(row?.series).toBe(blockId);
    expect(row?.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(row?.timer).toEqual({ prep: 10, set: 40, rest: 60 });
    expect(row?.pool).toEqual([entry('Hammer Curl', { lastReps: [12, 11, 10] }), entry('Incline DB Curl')]);
  });

  it('GET /focus/blocks reads the block back, and shows it to no one else', async () => {
    const list = (await owner('GET', `/focus/blocks?today=${TODAY}`)).json() as FocusBlockResponse[];
    expect(list.map((block) => block.id)).toEqual([blockId]);
    expect(list[0]?.pool[0]?.lastReps).toEqual([12, 11, 10]);
    expect((await other('GET', `/focus/blocks?today=${TODAY}`)).json()).toEqual([]);
  });

  it('PATCH and DELETE are scoped to the owner', async () => {
    expect((await other('PATCH', `/focus/blocks/${blockId}?today=${TODAY}`, { area: 'Core' })).statusCode).toBe(404);
    expect((await other('DELETE', `/focus/blocks/${blockId}`)).statusCode).toBe(404);
    expect((await prisma.focusBlock.findUnique({ where: { id: blockId } }))?.area).toBe('Biceps');

    const res = await owner('PATCH', `/focus/blocks/${blockId}?today=${TODAY}`, { area: 'Triceps', pool: [entry('Rope Pushdown')] });
    expect(res.statusCode).toBe(200);
    const row = await prisma.focusBlock.findUnique({ where: { id: blockId } });
    expect(row?.area).toBe('Triceps');
    expect(row?.pool).toEqual([entry('Rope Pushdown')]);
  });

  it('maps the (series, start) unique constraint to 409', async () => {
    const res = await owner('POST', `/focus/blocks?today=${TODAY}`, blockBody({ series: blockId }));
    expect(res.statusCode).toBe(409);
  });

  it('PUT /focus/blocks/order rewrites priorities', async () => {
    const second = (await owner('POST', `/focus/blocks?today=${TODAY}`, blockBody({ area: 'Core' }))).json() as FocusBlockResponse;
    const res = await owner('PUT', `/focus/blocks/order?today=${TODAY}`, { ids: [second.id, blockId] });
    expect(res.statusCode).toBe(200);
    const rows = await prisma.focusBlock.findMany({ where: { userId: USER_OWNER }, orderBy: { priority: 'asc' } });
    expect(rows.map((row) => [row.id, row.priority])).toEqual([
      [second.id, 1],
      [blockId, 2],
    ]);
    expect((await owner('DELETE', `/focus/blocks/${second.id}`)).statusCode).toBe(204);
  });

  it('creates an auto-roll successor on read exactly once, even for concurrent reads', async () => {
    const ended = (
      await owner(
        'POST',
        `/focus/blocks?today=${TODAY}`,
        blockBody({ area: 'Chest', period: 'quarterly', start: '2026-07-01', onEnd: 'autoroll', nextArea: 'Back' }),
      )
    ).json() as FocusBlockResponse;

    const reads = await Promise.all([1, 2, 3].map(() => owner('GET', `/focus/blocks?today=${TODAY}`)));
    for (const read of reads) expect(read.statusCode).toBe(200);

    const successors = await prisma.focusBlock.findMany({ where: { userId: USER_OWNER, series: ended.series, start: new Date('2026-10-01') } });
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ area: 'Back', onEnd: 'prompt', nextArea: null });
    expect(successors[0]?.pool).toEqual(defaultFocusPool('Back'));

    // Declining it flips the predecessor to prompt, so no later read recreates it.
    expect((await owner('DELETE', `/focus/blocks/${successors[0]?.id}`)).statusCode).toBe(204);
    await owner('GET', `/focus/blocks?today=${TODAY}`);
    expect(await prisma.focusBlock.count({ where: { userId: USER_OWNER, series: ended.series } })).toBe(1);
    expect((await prisma.focusBlock.findUnique({ where: { id: ended.id } }))?.onEnd).toBe('prompt');
    expect((await owner('DELETE', `/focus/blocks/${ended.id}`)).statusCode).toBe(204);
  });

  it('PUT /focus/settings stores the guide on user_settings', async () => {
    const res = await owner('PUT', '/focus/settings', { sets: 6, minutes: 15 });
    expect(res.statusCode).toBe(200);
    const row = await prisma.userSettings.findUnique({ where: { userId: USER_OWNER } });
    expect(row).toMatchObject({ focusBudgetSets: 6, focusBudgetMinutes: 15 });
    expect((await owner('GET', '/focus/settings')).json()).toEqual({ sets: 6, minutes: 15 });
    expect((await other('GET', '/focus/settings')).json()).toEqual({ sets: 9, minutes: 20 });
  });

  it('PUT /focus-state upserts one row per workout and keeps users apart', async () => {
    const url = `/programs/${PROGRAM}/workouts/1/focus-state`;
    const state: FocusDayState = {
      ...emptyFocusDayState(),
      trims: { [blockId]: ['Rope Pushdown'] },
      placement: 'before',
    };
    expect((await owner('PUT', url, state)).statusCode).toBe(200);
    expect((await owner('PUT', url, { ...state, dismissed: true })).statusCode).toBe(200);
    const rows = await prisma.focusDayState.findMany({ where: { userId: USER_OWNER } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ program: PROGRAM, macrocycleNum: 1, workoutNum: 1 });
    expect(rows[0]?.state).toEqual({ ...state, dismissed: true });
    expect((await other('GET', url)).json()).toEqual(emptyFocusDayState());
  });

  it('GET /focus plans the workout from the stored block, guide and day state', async () => {
    const res = await owner('GET', `/programs/${PROGRAM}/workouts/1/focus?today=${TODAY}`);
    expect(res.statusCode).toBe(200);
    const plan = res.json() as FocusDayPlanResponse;
    expect(plan.plannedLifts.length).toBeGreaterThan(0);
    expect(plan.budget).toEqual({ sets: 6, minutes: 15 });
    expect(plan.groups.map((group) => [group.block.id, group.trimmed])).toEqual([[blockId, ['Rope Pushdown']]]);
    expect(plan.sets).toBe(0);
  });

  it('GET /focus/blocks/:id/summary reads records across programs up to the block end', async () => {
    const record = (program: string, date: string, weight: number, reps: number) => ({
      userId: USER_OWNER,
      program,
      macrocycleNum: 1,
      workoutNum: 1,
      date: new Date(`${date}T00:00:00.000Z`),
      lift: 'Rope Pushdown',
      setNum: 1,
      weight,
      reps,
    });
    await prisma.liftRecord.createMany({
      data: [
        record(PROGRAM, '2026-09-20', 40, 12),
        record('leangains', '2026-10-31', 45, 12),
        record(PROGRAM, '2026-11-01', 60, 12),
        { ...record(PROGRAM, '2026-10-10', 999, 1), userId: USER_OTHER },
      ],
    });
    const res = await owner('GET', `/focus/blocks/${blockId}/summary`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual<FocusBlockSummaryResponse>({
      blockId,
      rangeStart: '2026-10-01',
      rangeEnd: '2026-10-31',
      sessions: 1,
      sets: 1,
      volume: 45 * 12,
      prs: [{ lift: 'Rope Pushdown', weight: 45, reps: 12, previousWeight: 40, previousReps: 12 }],
    });
  });
});
