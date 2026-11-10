import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { emptyFocusDayState, WorkoutResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { InMemoryMacrocycleRepository } from '../adapters/in-memory/macrocycle.adapter';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';
import { MACROCYCLE_ID_HEADER } from './macrocycle-history.util';

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
    expect(id).toEqual(expect.any(String));
    return { inject, repos, id: id as string };
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

  it('returns the current macrocycle id on GET workouts, unchanged by a renumbering', async () => {
    const user = await as('id-read');
    const macrocycles = (await user.repos()).macrocycle as InMemoryMacrocycleRepository;
    expect(user.id).toBe((await macrocycles.findByNumber(PROGRAM, 1))?.id);
    macrocycles.renumber(PROGRAM, 1, 2);
    expect((await macrocycles.findById(user.id))?.macrocycleNum).toBe(2);
  });

  it("answers every page write with the old number and the macrocycle's id with 409 macrocycle-moved, writing nothing", async () => {
    const user = await as('id-moved');
    const recordId = await logOne(user);
    ((await user.repos()).macrocycle as InMemoryMacrocycleRepository).renumber(PROGRAM, 1, 2);

    for (const write of pageWrites(recordId)) {
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
    expect((await repos.macrocycleDashboard.getMacrocycleDashboard(PROGRAM)).macrocycleNum).toBe(1);
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

  // The import routes' exclusive lock is covered against Postgres in macrocycle.db.e2e.spec.ts.
  it('answers every page write with 409 import-in-progress while the lock is held', async () => {
    const user = await as('id-locked');
    const recordId = await logOne(user);
    ((await user.repos()).macrocycle as InMemoryMacrocycleRepository).lockHeld = true;

    for (const write of pageWrites(recordId)) {
      const res = await user.inject(write.method, write.url, write.body, user.id);
      expect({ route: write.name, status: res.statusCode }).toEqual({ route: write.name, status: 409 });
      expect(res.json()).toMatchObject({ code: 'import-in-progress' });
    }
    expect(await (await user.repos()).liftRecord.getLiftRecords(PROGRAM, 1)).toHaveLength(1);
  });

  it('answers both import routes with 409 import-in-progress while the lock is held, writing nothing', async () => {
    const user = await as('id-locked-import');
    ((await user.repos()).macrocycle as InMemoryMacrocycleRepository).lockHeld = true;
    const csv = ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes', '5-3-1,4,1,2025-03-03,Squat,1,200,5,'].join('\n');
    const upload = (url: string) => {
      const boundary = '----MacrocycleIdBoundary';
      return app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: 'Bearer id-locked-import' },
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

    for (const url of [`${base}/lift-records/import`, `${base}/import?mode=commit&destination=lift-records`]) {
      const res = await upload(url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 409 });
      expect(res.json()).toMatchObject({ code: 'import-in-progress' });
    }
    const repos = await user.repos();
    expect(await repos.liftRecord.getLiftRecords(PROGRAM, 4)).toEqual([]);
    expect(await repos.macrocycle.findByNumber(PROGRAM, 4)).toBeNull();
  });
});
