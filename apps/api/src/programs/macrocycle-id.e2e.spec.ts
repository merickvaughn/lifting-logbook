import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { emptyFocusDayState, MACROCYCLE_ID_HEADER, WorkoutResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { InMemoryMacrocycleRepository } from '../adapters/in-memory/macrocycle.adapter';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

/**
 * The stable macrocycle id on page writes (proposal decision 3, #1198), in-memory adapters.
 * The renumbering engine comes with #1199, so these tests change a row's number directly.
 */
describe('Macrocycle id on writes (e2e, in-memory adapters)', () => {
  const PROGRAM = '5-3-1';
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const base = `/programs/${PROGRAM}`;

  /** Each test acts as its own user, so the in-memory store starts empty. */
  const as = async (user: string) => {
    const inject = (method: string, url: string, body?: unknown, macrocycleId?: string) =>
      app.getHttpAdapter().getInstance().inject({
        method: method as 'GET',
        url,
        headers: {
          authorization: `Bearer ${user}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(macrocycleId === undefined ? {} : { [MACROCYCLE_ID_HEADER]: macrocycleId }),
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const repos = (): Promise<RepositoryBundle> =>
      app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });

    const init = await inject('POST', `${base}/macrocycles/initialize`, { macrocycleDate: '2026-01-05' });
    expect(init.statusCode).toBe(201);
    await (await repos()).trainingMax.saveTrainingMaxes(PROGRAM, [
      { lift: 'Squat', weight: 300, dateUpdated: new Date('2025-12-01T00:00:00.000Z') },
    ]);
    const workout = await inject('GET', `${base}/workouts/1`);
    expect(workout.statusCode).toBe(200);
    const id = (workout.json() as WorkoutResponse).macrocycleId;
    if (typeof id !== 'string') throw new Error('the workout read returned no macrocycle id');
    return { inject, repos, id };
  };

  const logBody = (setNum: number) => ({
    macrocycleNum: 1,
    workoutNum: 1,
    date: '2026-01-05',
    lift: 'Squat',
    setNum,
    weight: 225,
    reps: 5,
  });

  /**
   * Every page write in decisions 2 and 3, aimed at macrocycle 1 workout 1. `recordId` is a
   * set already logged there, for the PATCH.
   */
  const pageWrites = (recordId: string) => [
    { name: 'POST lift-records', method: 'POST', url: `${base}/lift-records`, body: logBody(2), ok: 201 },
    { name: 'PATCH lift-records/:id', method: 'PATCH', url: `${base}/lift-records/${encodeURIComponent(recordId)}`, body: { reps: 6 }, ok: 200 },
    {
      name: 'POST lift-overrides',
      method: 'POST',
      url: `${base}/macrocycles/1/workouts/1/lift-overrides`,
      body: { lift: 'Bench Press', action: 'remove' },
      ok: 201,
    },
    { name: 'DELETE lift-overrides', method: 'DELETE', url: `${base}/macrocycles/1/workouts/1/lift-overrides/Bench%20Press`, ok: 204 },
    { name: 'PATCH reschedule', method: 'PATCH', url: `${base}/macrocycles/1/workouts/1/reschedule`, body: { newDate: '2026-01-07' }, ok: 204 },
    { name: 'POST skip', method: 'POST', url: `${base}/macrocycles/1/workouts/1/skip`, body: {}, ok: 204 },
    { name: 'DELETE skip', method: 'DELETE', url: `${base}/macrocycles/1/workouts/1/skip`, ok: 204 },
    { name: 'PUT focus-state', method: 'PUT', url: `${base}/workouts/1/focus-state`, body: { ...emptyFocusDayState(), dismissed: true }, ok: 200 },
    { name: 'POST macrocycles', method: 'POST', url: `${base}/macrocycles`, body: { fromMacrocycleNum: 1 }, ok: 201 },
  ];

  const logOne = async (user: Awaited<ReturnType<typeof as>>) => {
    const res = await user.inject('POST', `${base}/lift-records`, logBody(1), user.id);
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  };

  it("returns the current macrocycle's id on GET workouts, and the row keeps that id when renumbered", async () => {
    const user = await as('id-read');
    const macrocycles = (await user.repos()).macrocycle as InMemoryMacrocycleRepository;
    expect(user.id).toBe((await macrocycles.findByNumber(PROGRAM, 1))?.id);
    macrocycles.renumber(PROGRAM, 1, 2);
    expect((await macrocycles.findById(user.id))?.macrocycleNum).toBe(2);
  });

  it("answers every page write with the old number and the macrocycle's id with 409 macrocycle-moved, writing nothing", async () => {
    const user = await as('id-moved');
    const recordId = await logOne(user);
    const before = await user.repos();
    (before.macrocycle as InMemoryMacrocycleRepository).renumber(PROGRAM, 1, 2);
    // A renumbering moves the dashboard with its macrocycle, as #1199's will.
    const dashboard = await before.macrocycleDashboard.getMacrocycleDashboard(PROGRAM);
    await before.macrocycleDashboard.saveMacrocycleDashboard({ ...dashboard, macrocycleNum: 2 });

    // `PUT focus-state` names no number, so a renumbering doesn't make its page stale.
    for (const write of pageWrites(recordId).filter((w) => w.name !== 'PUT focus-state')) {
      const res = await user.inject(write.method, write.url, write.body, user.id);
      expect({ route: write.name, status: res.statusCode }).toEqual({ route: write.name, status: 409 });
      expect(res.json()).toMatchObject({ code: 'macrocycle-moved', macrocycleNum: 2 });
    }

    const repos = await user.repos();
    const records = await repos.liftRecord.getLiftRecords(PROGRAM, 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ setNum: 1, reps: 5 });
    expect(await repos.workoutLiftOverride.getOverrides(PROGRAM, 1, 1)).toEqual([]);
    expect(await repos.workoutDateOverride.getOverride(PROGRAM, 1, 1)).toBeNull();
    expect(await repos.workoutSkipOverride.getSkipsForMacrocycle(PROGRAM, 1)).toEqual(new Set());
    expect(await repos.focus.getDayState(PROGRAM, 1, 1)).toBeNull();
    expect((await repos.macrocycleDashboard.getMacrocycleDashboard(PROGRAM)).macrocycleNum).toBe(2);
    expect(await repos.macrocycle.highestNumber(PROGRAM)).toBe(2);
  });

  it('accepts a focus write with the id after a renumbering, under the new number', async () => {
    const user = await as('id-moved-focus');
    const repos = await user.repos();
    (repos.macrocycle as InMemoryMacrocycleRepository).renumber(PROGRAM, 1, 2);
    const dashboard = await repos.macrocycleDashboard.getMacrocycleDashboard(PROGRAM);
    await repos.macrocycleDashboard.saveMacrocycleDashboard({ ...dashboard, macrocycleNum: 2 });

    const res = await user.inject('PUT', `${base}/workouts/1/focus-state`, { ...emptyFocusDayState(), dismissed: true }, user.id);
    expect(res.statusCode).toBe(200);
    expect((await repos.focus.getDayState(PROGRAM, 2, 1))?.dismissed).toBe(true);
  });

  it("answers an id from another program, or one the user doesn't have, with 404", async () => {
    const user = await as('id-unknown');
    const recordId = await logOne(user);
    for (const write of pageWrites(recordId)) {
      const res = await user.inject(write.method, write.url, write.body, 'no-such-id');
      expect({ route: write.name, status: res.statusCode }).toEqual({ route: write.name, status: 404 });
      expect(res.json()).toMatchObject({ code: 'macrocycle-not-found' });
    }
  });

  it('accepts every page write with no id and logs each one', async () => {
    const user = await as('id-missing');
    const recordId = await logOne(user);
    const log = jest.spyOn(Logger.prototype, 'log');

    for (const write of pageWrites(recordId)) {
      const res = await user.inject(write.method, write.url, write.body);
      expect({ route: write.name, status: res.statusCode }).toEqual({ route: write.name, status: write.ok });
    }

    const counted = log.mock.calls
      .filter(([, message]) => message === 'Macrocycle write without an id (#1198)')
      .map(([fields]) => (fields as { route: string }).route);
    expect(counted).toEqual(pageWrites(recordId).map((w) => w.name));
  });

  it('accepts every page write with the right id, and logs none as missing', async () => {
    const user = await as('id-ok');
    const recordId = await logOne(user);
    const log = jest.spyOn(Logger.prototype, 'log');

    for (const write of pageWrites(recordId)) {
      const res = await user.inject(write.method, write.url, write.body, user.id);
      expect({ route: write.name, status: res.statusCode }).toEqual({ route: write.name, status: write.ok });
    }
    expect(log.mock.calls.some(([, message]) => message === 'Macrocycle write without an id (#1198)')).toBe(false);
  });

  /**
   * The macrocycle writes that carry no id, but still take the lock (decision 13): starting the
   * next macrocycle, initializing one, and deleting the current one.
   */
  const macrocycleWrites = [
    { name: 'POST macrocycles', method: 'POST', url: `${base}/macrocycles`, body: {} },
    { name: 'POST macrocycles/initialize', method: 'POST', url: `${base}/macrocycles/initialize`, body: { macrocycleDate: '2026-01-05' } },
    { name: 'DELETE macrocycles/current', method: 'DELETE', url: `${base}/macrocycles/current` },
  ];

  const csv = ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes', '5-3-1,4,1,2025-03-03,Squat,1,200,5,'].join('\n');
  const upload = (user: string, url: string) => {
    const boundary = '----MacrocycleIdBoundary';
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${user}` },
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
  const commitImport = `${base}/import?mode=commit&destination=lift-records`;
  const imports = [`${base}/lift-records/import`, commitImport];

  // The same lock against Postgres, including the import's wait, is in macrocycle.db.e2e.spec.ts.
  it('answers every page write and macrocycle start or delete with 409 import-in-progress while an import holds the lock', async () => {
    const user = await as('id-locked');
    const recordId = await logOne(user);
    ((await user.repos()).macrocycle as InMemoryMacrocycleRepository).lockHeld = 'exclusive';

    for (const write of [...pageWrites(recordId), ...macrocycleWrites]) {
      const res = await user.inject(write.method, write.url, write.body, user.id);
      expect({ route: write.name, status: res.statusCode }).toEqual({ route: write.name, status: 409 });
      expect(res.json()).toMatchObject({ code: 'import-in-progress' });
    }
    const repos = await user.repos();
    expect(await repos.liftRecord.getLiftRecords(PROGRAM, 1)).toHaveLength(1);
    expect((await repos.macrocycleDashboard.getMacrocycleDashboard(PROGRAM)).macrocycleNum).toBe(1);
    expect((await repos.macrocycle.list(PROGRAM)).map((row) => row.macrocycleNum)).toEqual([1]);
  });

  it('lets page writes and macrocycle starts share the lock with other page writes', async () => {
    const user = await as('id-shared');
    await logOne(user);
    ((await user.repos()).macrocycle as InMemoryMacrocycleRepository).lockHeld = 'shared';

    expect((await user.inject('POST', `${base}/macrocycles/1/workouts/1/skip`, {}, user.id)).statusCode).toBe(204);
    expect((await user.inject('POST', `${base}/macrocycles`, {})).statusCode).toBe(201);
  });

  it('answers both import routes with 409 macrocycle-busy when page writes hold the lock past the wait, writing nothing', async () => {
    const user = await as('id-busy-import');
    ((await user.repos()).macrocycle as InMemoryMacrocycleRepository).lockHeld = 'shared';

    for (const url of imports) {
      const res = await upload('id-busy-import', url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 409 });
      expect(res.json()).toMatchObject({
        code: 'macrocycle-busy',
        message: 'Your workouts are being saved. Try the import again in a moment.',
      });
    }
    const repos = await user.repos();
    expect(await repos.liftRecord.getLiftRecords(PROGRAM, 4)).toEqual([]);
    expect(await repos.macrocycle.findByNumber(PROGRAM, 4)).toBeNull();
  });

  it('answers an import undo with 409 macrocycle-busy while page writes hold the lock, removing nothing', async () => {
    const user = await as('id-busy-undo');
    const commit = await upload('id-busy-undo', commitImport);
    expect(commit.statusCode).toBe(200);
    const { batchId } = commit.json() as { batchId: string };
    const macrocycles = (await user.repos()).macrocycle as InMemoryMacrocycleRepository;
    macrocycles.lockHeld = 'shared';

    const res = await user.inject('POST', `${base}/import/${batchId}/undo`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'macrocycle-busy',
      message: 'Your workouts are being saved. Try the undo again in a moment.',
    });
    const repos = await user.repos();
    expect(await repos.liftRecord.getLiftRecords(PROGRAM, 4)).toHaveLength(1);
    expect(await repos.macrocycle.findByNumber(PROGRAM, 4)).not.toBeNull();

    macrocycles.lockHeld = null;
    expect((await user.inject('POST', `${base}/import/${batchId}/undo`)).statusCode).toBe(200);
    expect(await repos.macrocycle.findByNumber(PROGRAM, 4)).toBeNull();
  });

  it('gives no id, rather than a 409, when the current macrocycle has no row and an import holds the lock', async () => {
    const user = await as('id-read-locked');
    const macrocycles = (await user.repos()).macrocycle as InMemoryMacrocycleRepository;
    // A macrocycle the previous API revision started without a row.
    await macrocycles.delete(PROGRAM, [1]);
    macrocycles.lockHeld = 'exclusive';

    const locked = await user.inject('GET', `${base}/workouts/1`);
    expect(locked.statusCode).toBe(200);
    expect((locked.json() as WorkoutResponse).macrocycleId).toBeUndefined();
    expect(await macrocycles.findByNumber(PROGRAM, 1)).toBeNull();

    macrocycles.lockHeld = null;
    const read = await user.inject('GET', `${base}/workouts/1`);
    expect((read.json() as WorkoutResponse).macrocycleId).toBe((await macrocycles.findByNumber(PROGRAM, 1))?.id);
  });

  // An import that commits between reading the current macrocycle and taking the lock would
  // leave the request working from a number it has since moved, so the lock comes first.
  it.each([
    { name: 'GET workouts', method: 'GET', url: `${base}/workouts/1` },
    { name: 'POST macrocycles', method: 'POST', url: `${base}/macrocycles`, body: {} },
    { name: 'POST macrocycles from a number', method: 'POST', url: `${base}/macrocycles`, body: { fromMacrocycleNum: 1 } },
    { name: 'PUT focus-state', method: 'PUT', url: `${base}/workouts/1/focus-state`, body: { ...emptyFocusDayState(), dismissed: true } },
  ])('$name takes the macrocycle lock before it reads the current macrocycle', async ({ method, url, body }) => {
    const user = await as(`id-lock-first-${method}-${url.length}-${body && 'fromMacrocycleNum' in body ? 'from' : 'next'}`);
    await logOne(user);
    const repos = await user.repos();
    const lock = jest.spyOn(repos.macrocycle, 'tryLockShared');
    const read = jest.spyOn(repos.macrocycleDashboard, 'getMacrocycleDashboard');

    const res = await user.inject(method, url, body, user.id);
    expect(res.statusCode).toBeLessThan(300);
    expect(lock).toHaveBeenCalled();
    expect(read).toHaveBeenCalled();
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0] ?? 0);
  });

  it('answers a focus write for a macrocycle that is no longer current with 409 macrocycle-not-current, writing nothing', async () => {
    const user = await as('id-not-current');
    await logOne(user);
    expect((await user.inject('POST', `${base}/macrocycles`, {})).statusCode).toBe(201);

    const res = await user.inject('PUT', `${base}/workouts/1/focus-state`, { ...emptyFocusDayState(), dismissed: true }, user.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'macrocycle-not-current', macrocycleNum: 1 });
    const repos = await user.repos();
    expect(await repos.focus.getDayState(PROGRAM, 1, 1)).toBeNull();
    expect(await repos.focus.getDayState(PROGRAM, 2, 1)).toBeNull();
  });
});
