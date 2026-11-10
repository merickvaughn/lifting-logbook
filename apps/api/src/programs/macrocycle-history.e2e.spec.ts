import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { LiftRecord } from '@lifting-logbook/core';
import { emptyFocusDayState, MacrocycleSummaryResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { InMemoryMacrocycleRepository } from '../adapters/in-memory/macrocycle.adapter';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

/**
 * Macrocycle history (ADR-042, #1197), in-memory adapters. Piece 1 writes no `imported`
 * rows itself, so these tests seed them through the repository bundle.
 */
describe('Macrocycle history HTTP (e2e, in-memory adapters)', () => {
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

  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  /** Each test acts as its own user, so the in-memory store starts empty. */
  const as = (user: string) => {
    const inject = (method: string, url: string, body?: unknown) =>
      app.getHttpAdapter().getInstance().inject({
        method: method as 'GET',
        url,
        headers:
          body === undefined
            ? { authorization: `Bearer ${user}` }
            : { 'content-type': 'application/json', authorization: `Bearer ${user}` },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const repos = (): Promise<RepositoryBundle> =>
      app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });
    const set = (macrocycleNum: number, date: string, overrides: Partial<LiftRecord> = {}): LiftRecord => ({
      program: PROGRAM,
      macrocycleNum,
      workoutNum: 1,
      date: day(date),
      lift: 'Squat',
      setNum: 1,
      weight: 200,
      reps: 5,
      notes: '',
      ...overrides,
    });
    return {
      inject,
      set,
      /** An `imported` macrocycle with one set, as piece 2's Assign step will store it. */
      seedImported: async (macrocycleNum: number, start: string, end: string) => {
        const bundle = await repos();
        (bundle.macrocycle as InMemoryMacrocycleRepository).seed({
          program: PROGRAM,
          macrocycleNum,
          startDate: day(start),
          endDate: day(end),
          status: 'completed',
          statusChosen: false,
          origin: 'imported',
          unmatched: false,
          importedThrough: null,
        });
        await bundle.liftRecord.appendLiftRecords(PROGRAM, [set(macrocycleNum, start, { weight: 999, notes: 'imported' })]);
      },
      list: async () => {
        const res = await inject('GET', `/programs/${PROGRAM}/macrocycles`);
        expect(res.statusCode).toBe(200);
        return res.json() as MacrocycleSummaryResponse[];
      },
      /** Starts the first live macrocycle, with a Squat max for the sets these tests log. */
      initialize: async (macrocycleDate: string) => {
        const res = await inject('POST', `/programs/${PROGRAM}/macrocycles/initialize`, { macrocycleDate });
        expect(res.statusCode).toBe(201);
        await (await repos()).trainingMax.saveTrainingMaxes(PROGRAM, [
          { lift: 'Squat', weight: 300, dateUpdated: day('2025-12-01') },
        ]);
        return res.json() as { macrocycleNum: number };
      },
      startNext: async (body: Record<string, unknown> = {}) => {
        const res = await inject('POST', `/programs/${PROGRAM}/macrocycles`, body);
        expect(res.statusCode).toBe(201);
        return res.json() as { macrocycleNum: number };
      },
      log: (macrocycleNum: number, date: string, setNum = 1) =>
        inject('POST', `/programs/${PROGRAM}/lift-records`, {
          macrocycleNum,
          workoutNum: 1,
          date,
          lift: 'Squat',
          setNum,
          weight: 225,
          reps: 5,
        }),
      repos,
    };
  };

  describe('GET /programs/:program/macrocycles', () => {
    it('lists macrocycles by start date, each with its stable id', async () => {
      const user = as('history-list');
      await user.seedImported(2, '2025-06-02', '2025-07-14');
      await user.seedImported(1, '2025-01-06', '2025-02-17');
      await user.initialize('2026-01-05');

      const list = await user.list();

      expect(list.map((m) => [m.macrocycleNum, m.startDate, m.origin])).toEqual([
        [1, '2025-01-06', 'imported'],
        [2, '2025-06-02', 'imported'],
        [3, '2026-01-05', 'live'],
      ]);
      for (const m of list) expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Set(list.map((m) => m.id)).size).toBe(3);
      expect(list.map((m) => m.current)).toEqual([false, false, true]);
      expect(list[0]).toMatchObject({ endDate: '2025-02-17', status: 'completed' });
    });

    it('lists imported history for a program with no current macrocycle', async () => {
      const user = as('history-list-no-dashboard');
      await user.seedImported(1, '2025-01-06', '2025-02-17');

      expect(await user.list()).toEqual([expect.objectContaining({ macrocycleNum: 1, current: false })]);
    });

    it('is empty for a program with no history', async () => {
      expect(await as('history-list-empty').list()).toEqual([]);
    });
  });

  describe('imported history stays off the live pages', () => {
    it('shows no imported sets on GET workouts/1 when the program has no dashboard', async () => {
      const user = as('history-no-dashboard');
      await user.seedImported(1, '2025-01-06', '2025-02-17');

      const res = await user.inject('GET', `/programs/${PROGRAM}/workouts/1`);

      expect(res.statusCode).toBe(200);
      const body = res.json() as { macrocycleNum: number; lifts: { sets: { weight: number }[] }[] };
      expect(body.macrocycleNum).toBe(2);
      expect(body.lifts.flatMap((l) => l.sets).some((s) => s.weight === 999)).toBe(false);
    });

    it('returns no imported rows for the current macrocycle, and the next number is unused', async () => {
      const user = as('history-current');
      await user.seedImported(1, '2025-01-06', '2025-02-17');

      expect((await user.initialize('2026-01-05')).macrocycleNum).toBe(2);
      const records = (await user.inject('GET', `/programs/${PROGRAM}/lift-records`)).json() as { weight: number }[];
      expect(records).toEqual([]);

      // The current macrocycle has zero records, and the next still lands past every stored number.
      expect((await user.startNext()).macrocycleNum).toBe(3);
      expect((await user.list()).map((m) => m.macrocycleNum)).toEqual([1, 2, 3]);
    });

    it('writes nothing onto an imported number 1 from PUT focus-state with no dashboard', async () => {
      const user = as('history-focus-state');
      await user.seedImported(1, '2025-01-06', '2025-02-17');

      const res = await user.inject('PUT', `/programs/${PROGRAM}/workouts/1/focus-state`, {
        ...emptyFocusDayState(),
        dismissed: true,
      });

      expect(res.statusCode).toBe(200);
      const bundle = await user.repos();
      expect(await bundle.focus.getDayState(PROGRAM, 1, 1)).toBeNull();
      expect(await bundle.focus.getDayState(PROGRAM, 2, 1)).toMatchObject({ dismissed: true });
    });
  });

  describe('numbering', () => {
    it('numbers every new macrocycle past what is stored: dense, in start-date order, each with a row', async () => {
      const user = as('history-numbering');
      await user.seedImported(1, '2025-01-06', '2025-02-17');

      expect((await user.initialize('2026-01-05')).macrocycleNum).toBe(2);
      expect((await user.log(2, '2026-01-05')).statusCode).toBe(201);
      expect((await user.startNext({ macrocycleDate: '2026-03-02' })).macrocycleNum).toBe(3);
      // From macrocycle 2's records, but numbered past everything stored, not 2 + 1.
      expect((await user.startNext({ fromMacrocycleNum: 2, macrocycleDate: '2026-05-04' })).macrocycleNum).toBe(4);

      const list = await user.list();
      expect(list.map((m) => m.macrocycleNum)).toEqual([1, 2, 3, 4]);
      expect(list.map((m) => m.startDate)).toEqual(['2025-01-06', '2026-01-05', '2026-03-02', '2026-05-04']);
      expect(list.map((m) => m.origin)).toEqual(['imported', 'live', 'live', 'live']);
    });

    it('closes the previous macrocycle with an end date and a status when the next starts', async () => {
      const user = as('history-closing');
      await user.initialize('2026-01-05');
      expect((await user.log(1, '2026-01-07')).statusCode).toBe(201);
      expect((await user.log(1, '2026-01-21', 2)).statusCode).toBe(201);

      await user.startNext({ macrocycleDate: '2026-03-02' });

      const [closed, current] = await user.list();
      // One workout of the program logged, so it ended unfinished, on its last session.
      expect(closed).toMatchObject({ macrocycleNum: 1, endDate: '2026-01-21', status: 'abandoned', current: false });
      expect(current).toMatchObject({ macrocycleNum: 2, endDate: null, status: 'in-progress', current: true });
    });
  });

  describe('writes to imported history', () => {
    const csvUpload = (user: string, csv: string) => {
      const boundary = '----MacrocycleHistoryBoundary';
      return app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${PROGRAM}/lift-records/import`,
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
    const HEADER = 'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes';

    /** Every route decision 2 lists, against macrocycle `num`. */
    const routes = (num: number) => [
      ['POST lift-records', 'POST', `/programs/${PROGRAM}/lift-records`, {
        macrocycleNum: num, workoutNum: 1, date: '2025-01-08', lift: 'Squat', setNum: 2, weight: 500, reps: 5,
      }],
      ['PATCH lift-records/:id', 'PATCH', `/programs/${PROGRAM}/lift-records/${PROGRAM}-${num}-1-20250106-Squat-1`, { weight: 500 }],
      ['POST lift-override', 'POST', `/programs/${PROGRAM}/macrocycles/${num}/workouts/1/lift-overrides`, { action: 'add', lift: 'Squat' }],
      ['DELETE lift-override', 'DELETE', `/programs/${PROGRAM}/macrocycles/${num}/workouts/1/lift-overrides/Squat`, undefined],
      ['PATCH reschedule', 'PATCH', `/programs/${PROGRAM}/macrocycles/${num}/workouts/1/reschedule`, { newDate: '2026-01-09' }],
      ['POST skip', 'POST', `/programs/${PROGRAM}/macrocycles/${num}/workouts/1/skip`, {}],
      ['DELETE skip', 'DELETE', `/programs/${PROGRAM}/macrocycles/${num}/workouts/1/skip`, undefined],
      ['fromMacrocycleNum', 'POST', `/programs/${PROGRAM}/macrocycles`, { fromMacrocycleNum: num }],
    ] as const;

    it.each([
      ['an imported macrocycle', 1],
      ['an unknown number', 7],
    ])('rejects every write on %s with a 4xx, and leaves the training maxes alone', async (label, num) => {
      const user = as(`history-guard-${num}`);
      await user.seedImported(1, '2025-01-06', '2025-02-17');
      await user.initialize('2026-01-05');
      const maxesBefore = (await user.inject('GET', `/programs/${PROGRAM}/training-maxes`)).json();
      const bundle = await user.repos();
      const recordsBefore = await bundle.liftRecord.getLiftRecords(PROGRAM, num);

      const results: [string, number, boolean][] = [];
      for (const [route, method, url, body] of routes(num)) {
        const status = (await user.inject(method, url, body)).statusCode;
        results.push([route, status, status >= 400 && status < 500]);
      }
      // Each row names its route and status, so a failure says which one let the write through.
      expect(results).toEqual(routes(num).map(([route]) => [route, expect.any(Number), true]));

      expect((await user.inject('GET', `/programs/${PROGRAM}/training-maxes`)).json()).toEqual(maxesBefore);
      expect(await bundle.liftRecord.getLiftRecords(PROGRAM, num)).toEqual(recordsBefore);
      expect(await bundle.workoutLiftOverride.getOverrides(PROGRAM, num, 1)).toEqual([]);
    });

    it('rejects an upload into an imported macrocycle with 409, writing nothing', async () => {
      const user = as('history-guard-upload');
      await user.seedImported(1, '2025-01-06', '2025-02-17');

      const upload = await csvUpload('history-guard-upload', [HEADER, `${PROGRAM},1,1,2025-01-08,Squat,1,500,5,`].join('\n'));

      expect(upload.statusCode).toBe(409);
      expect(upload.json()).toMatchObject({ code: 'macrocycle-read-only' });
      expect(await (await user.repos()).liftRecord.getLiftRecords(PROGRAM, 1)).toEqual([
        expect.objectContaining({ weight: 999 }),
      ]);
    });

    it('answers the guarded set routes with the macrocycle codes', async () => {
      const user = as('history-guard-codes');
      await user.seedImported(1, '2025-01-06', '2025-02-17');
      await user.initialize('2026-01-05');

      const readOnly = await user.log(1, '2025-01-08', 2);
      expect(readOnly.statusCode).toBe(409);
      expect(readOnly.json()).toMatchObject({ code: 'macrocycle-read-only' });
      const unknown = await user.log(7, '2025-01-08', 2);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'macrocycle-not-found' });
    });

    it('keeps a legacy macrocycle writable', async () => {
      const user = as('history-legacy');
      await user.initialize('2026-01-05');
      // A file number with no macrocycle gets a legacy one.
      const upload = await csvUpload('history-legacy', [HEADER, `${PROGRAM},5,1,2025-03-03,Squat,1,200,5,`].join('\n'));
      expect(upload.statusCode).toBe(201);
      expect((await user.list()).find((m) => m.macrocycleNum === 5)).toMatchObject({
        origin: 'legacy',
        status: 'unknown',
        startDate: '2025-03-03',
        endDate: '2025-03-03',
      });

      expect((await user.log(5, '2025-03-03', 2)).statusCode).toBe(201);
      const edit = await user.inject('PATCH', `/programs/${PROGRAM}/lift-records/${PROGRAM}-5-1-20250303-Squat-2`, {
        weight: 205,
      });
      expect(edit.statusCode).toBe(200);
      expect(edit.json()).toMatchObject({ weight: 205 });
    });
  });

  describe('DELETE /programs/:program/macrocycles/current', () => {
    it('keeps imported macrocycles and their sets, and removes live and legacy ones from every table', async () => {
      const user = as('history-delete');
      await user.seedImported(1, '2025-01-06', '2025-02-17');
      await user.initialize('2026-01-05');
      expect((await user.log(2, '2026-01-07')).statusCode).toBe(201);
      const bundle = await user.repos();
      // A legacy macrocycle with a row in every table that holds a number.
      await bundle.macrocycle.create({
        program: PROGRAM, macrocycleNum: 3, startDate: day('2025-09-01'), status: 'unknown', origin: 'legacy',
      });
      await bundle.liftRecord.appendLiftRecords(PROGRAM, [user.set(3, '2025-09-01')]);
      for (const num of [2, 3]) {
        await bundle.macrocycleScheduledWorkout.saveScheduledWorkouts(PROGRAM, num, [
          { workoutNum: 1, weekNum: 1, scheduledDate: day('2026-01-07') },
        ]);
        await bundle.workoutDateOverride.upsertOverride(PROGRAM, num, 1, day('2026-01-08'));
        await bundle.workoutSkipOverride.skipWorkout(PROGRAM, num, 2);
        await bundle.workoutLiftOverride.upsertOverride(PROGRAM, num, 1, { action: 'add', lift: 'Squat' });
        await bundle.focus.saveDayState(PROGRAM, num, 1, { ...emptyFocusDayState(), dismissed: true });
      }

      const res = await user.inject('DELETE', `/programs/${PROGRAM}/macrocycles/current`);
      expect(res.statusCode).toBe(204);

      expect((await user.list()).map((m) => [m.macrocycleNum, m.origin])).toEqual([[1, 'imported']]);
      expect(await bundle.liftRecord.getLiftRecords(PROGRAM, 1)).toEqual([expect.objectContaining({ weight: 999 })]);
      for (const num of [2, 3]) {
        expect(await bundle.liftRecord.getLiftRecords(PROGRAM, num)).toEqual([]);
        expect(await bundle.macrocycleScheduledWorkout.getScheduledWorkouts(PROGRAM, num)).toEqual([]);
        expect(await bundle.workoutDateOverride.getOverridesForMacrocycle(PROGRAM, num)).toEqual(new Map());
        expect(await bundle.workoutSkipOverride.getSkipsForMacrocycle(PROGRAM, num)).toEqual(new Set());
        expect(await bundle.workoutLiftOverride.getOverridesForMacrocycle(PROGRAM, num)).toEqual(new Map());
        expect(await bundle.focus.getDayState(PROGRAM, num, 1)).toBeNull();
      }
    });
  });
});
