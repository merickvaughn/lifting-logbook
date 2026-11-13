import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { parseCsvText, parseLiftRecords, segmentLiftHistory } from '@lifting-logbook/core';
import {
  ImportCommitResponse,
  LiftRecordResponse,
  MACROCYCLE_ID_HEADER,
  MacrocycleSummaryResponse,
  NON_CYCLE_PROGRAM,
  NonCycleReferenceResponse,
  NonCycleWorkoutResponse,
  TrainingMaxHistoryResponse,
  TrainingMaxResponse,
} from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { seedTrainingMaxes } from '../adapters/in-memory/fixtures';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

/** Non-cycle workouts (proposal 2026-11-06, decision 23, #1184), in-memory adapters. */
describe('Non-cycle workouts (e2e, in-memory adapters)', () => {
  const PROGRAM_A = '5-3-1';
  const PROGRAM_B = 'leangains';
  let app: NestFastifyApplication;
  let nextUser = 0;

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

  const isoDay = (offsetDays: number) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays))
      .toISOString()
      .slice(0, 10);
  };
  const TODAY = isoDay(0);

  /** A fresh user, so the in-memory store starts empty. */
  const newUser = () => {
    const user = `non-cycle-e2e-${++nextUser}`;
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
    const importCsv = (program: string, csv: string, query: string) => {
      const boundary = '----NonCycleBoundary';
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="upload.csv"',
        'Content-Type: text/csv',
        '',
        csv,
        `--${boundary}--`,
      ].join('\r\n');
      return app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${program}/${query}`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${user}` },
        payload,
      });
    };
    /** Starts a workout with one set and returns it. */
    const start = async (set: Partial<{ date: string; lift: string; setNum: number; weight: number; reps: number }> = {}) => {
      const res = await inject('POST', '/non-cycle-workouts', {
        date: TODAY,
        lift: 'Squat',
        setNum: 1,
        weight: 225,
        reps: 5,
        ...set,
      });
      expect(res.statusCode).toBe(201);
      return res.json() as NonCycleWorkoutResponse;
    };
    const list = async () => {
      const res = await inject('GET', '/non-cycle-workouts');
      expect(res.statusCode).toBe(200);
      return res.json() as LiftRecordResponse[];
    };
    return { user, inject, repos, importCsv, start, list };
  };

  describe('recording one with no plan', () => {
    it('stores a set under the reserved program, and History lists it', async () => {
      const { start, list } = newUser();
      const workout = await start({ weight: 235, reps: 3 });
      expect(workout).toMatchObject({ workoutNum: 1, date: TODAY });
      expect(workout.records).toEqual([
        expect.objectContaining({ program: NON_CYCLE_PROGRAM, macrocycleNum: 1, workoutNum: 1, lift: 'Squat', weight: 235, reps: 3 }),
      ]);
      expect((await list()).map((r) => r.id)).toEqual(workout.records.map((r) => r.id));
    });

    it('takes a date one day past the server’s, and refuses two days past it', async () => {
      const { inject, start } = newUser();
      expect((await start({ date: isoDay(1) })).date).toBe(isoDay(1));
      const late = await inject('POST', '/non-cycle-workouts', { date: isoDay(2), lift: 'Squat', setNum: 1, weight: 225, reps: 5 });
      expect(late.statusCode).toBe(400);
      expect((await inject('POST', '/non-cycle-workouts', { lift: 'Squat', setNum: 1, weight: 225, reps: 5 })).statusCode).toBe(400);
    });

    it('keeps two workouts on one date separate', async () => {
      const { start, list } = newUser();
      const first = await start();
      const second = await start();
      expect([first.workoutNum, second.workoutNum]).toEqual([1, 2]);
      expect((await list()).map((r) => r.workoutNum).sort((a, b) => a - b)).toEqual([1, 2]);
    });

    it('adds later sets on the workout’s date, past workout 1000', async () => {
      const { inject, repos, start } = newUser();
      const seeded = await start();
      // Workout 1000 is stored, as if a thousand had been recorded.
      await (await repos()).liftRecord.appendLiftRecords(NON_CYCLE_PROGRAM, [
        { program: NON_CYCLE_PROGRAM, macrocycleNum: 1, workoutNum: 1000, date: new Date(`${TODAY}T00:00:00.000Z`), lift: 'Bench Press', setNum: 1, weight: 100, reps: 5, notes: '' },
      ]);
      const workout = await start();
      expect(workout.workoutNum).toBe(1001);
      const set = (fields: Record<string, unknown>) =>
        inject('POST', `/programs/${NON_CYCLE_PROGRAM}/lift-records`, {
          macrocycleNum: 1,
          workoutNum: 1001,
          date: TODAY,
          lift: 'Squat',
          setNum: 2,
          weight: 225,
          reps: 4,
          ...fields,
        }, workout.macrocycleId);
      expect((await set({})).statusCode).toBe(201);
      // Its date is the workout's, and only starting one takes a number.
      expect((await set({ setNum: 3, date: isoDay(-1) })).statusCode).toBe(400);
      expect((await set({ workoutNum: 1002 })).statusCode).toBe(404);
      expect(seeded.macrocycleId).toBe(workout.macrocycleId);
      const read = await inject('GET', '/non-cycle-workouts/1001');
      expect((read.json() as NonCycleWorkoutResponse).records.map((r) => r.setNum)).toEqual([1, 2]);
    });

    it('keeps a program’s workout numbers at 1000', async () => {
      const { inject } = newUser();
      expect((await inject('POST', `/programs/${PROGRAM_A}/macrocycles/initialize`, { macrocycleDate: TODAY })).statusCode).toBe(201);
      const workout = await inject('GET', `/programs/${PROGRAM_A}/workouts/1`);
      const id = (workout.json() as { macrocycleId: string }).macrocycleId;
      const res = await inject('POST', `/programs/${PROGRAM_A}/lift-records`, {
        macrocycleNum: 1, workoutNum: 1001, date: TODAY, lift: 'Squat', setNum: 1, weight: 225, reps: 5,
      }, id);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('training maxes', () => {
    // 5/3/1 raises its maxes each macrocycle on its own, so the result is compared with a user
    // who logged the same program sets and no non-cycle set.
    it('come out of the next macrocycle as if a heavier non-cycle set had never been logged', async () => {
      const startDate = isoDay(-30);
      const nextMacrocycle = async (withNonCycleSet: boolean) => {
        const { inject, repos, start } = newUser();
        expect((await inject('POST', `/programs/${PROGRAM_A}/macrocycles/initialize`, { macrocycleDate: startDate })).statusCode).toBe(201);
        await (await repos()).trainingMax.saveTrainingMaxes(PROGRAM_A, seedTrainingMaxes());
        const current = await (await repos()).macrocycle.findByNumber(PROGRAM_A, 1);
        const logged = await inject('POST', `/programs/${PROGRAM_A}/lift-records`, {
          macrocycleNum: 1, workoutNum: 1, date: startDate, lift: 'Squat', setNum: 1, weight: 225, reps: 5,
        }, current?.id);
        expect(logged.statusCode).toBe(201);
        // Far past the 315 lb max: an estimate from it would raise the max.
        if (withNonCycleSet) await start({ date: isoDay(-29), lift: 'Squat', weight: 415, reps: 10 });

        const next = await inject('POST', `/programs/${PROGRAM_A}/macrocycles`, { fromMacrocycleNum: 1 }, current?.id);
        expect(next.statusCode === 201 ? 201 : next.body).toBe(201);
        const maxes = (await inject('GET', `/programs/${PROGRAM_A}/training-maxes`)).json() as TrainingMaxResponse[];
        const history = (await inject('GET', `/programs/${PROGRAM_A}/training-maxes/history`)).json() as TrainingMaxHistoryResponse;
        return {
          maxes: maxes.map(({ lift, weight }) => ({ lift, weight })),
          history: history.entries.map(({ lift, weight, source, isPR, goalMet }) => ({ lift, weight, source, isPR, goalMet })),
        };
      };

      const withSet = await nextMacrocycle(true);
      const without = await nextMacrocycle(false);
      expect(withSet.maxes.length).toBeGreaterThan(0);
      expect(withSet).toEqual(without);
    });

    it('can’t be a macrocycle’s source under the reserved id', async () => {
      const { inject, start } = newUser();
      await start();
      expect((await inject('POST', `/programs/${NON_CYCLE_PROGRAM}/macrocycles`, { fromMacrocycleNum: 1 })).statusCode).toBe(400);
    });
  });

  describe('the reserved id', () => {
    it.each([
      ['PATCH', 'training-maxes', { maxes: [{ lift: 'Squat', weight: 999 }] }],
      ['POST', 'switch', {}],
      ['POST', 'macrocycles/initialize', { macrocycleDate: '2026-01-05' }],
      ['POST', 'macrocycles', {}],
      ['POST', 'training-maxes/recalculate', {}],
      ['GET', 'macrocycles', undefined],
      ['GET', 'macrocycles/current', undefined],
      ['GET', 'lift-records', undefined],
      ['GET', 'workouts/1', undefined],
      ['GET', 'non-cycle-reference?lift=Squat', undefined],
    ])('is a 400 from %s %s', async (method, route, body) => {
      const { inject, start } = newUser();
      await start();
      const res = await inject(method, `/programs/${NON_CYCLE_PROGRAM}/${route}`, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'program-reserved' });
    });

    // Both are global guards, so registration order decides which runs first.
    it('is checked after sign-in, so a request with no user gets a 401', async () => {
      const res = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: `/programs/${NON_CYCLE_PROGRAM}/macrocycles` });
      expect(res.statusCode).toBe(401);
    });

    it('is a 400 from the file-number import paths', async () => {
      const { importCsv } = newUser();
      const csv = ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes', `5-3-1,1,1,${TODAY},Squat,1,225,5,`].join('\n');
      expect((await importCsv(NON_CYCLE_PROGRAM, csv, 'lift-records/import')).statusCode).toBe(400);
      expect((await importCsv(NON_CYCLE_PROGRAM, csv, 'import?mode=commit&destination=lift-records')).statusCode).toBe(400);
    });

    // The program list is the built-in catalog (reserved-program.registry.spec.ts) plus custom
    // programs, whose ids are UUIDs and which the in-memory adapters don't store.
    it('is missing from the past-macrocycles list', async () => {
      const { inject, repos, start } = newUser();
      expect((await inject('POST', `/programs/${PROGRAM_A}/switch`)).statusCode).toBe(200);
      const workout = await start();
      // The row exists, so leaving it out is the list's doing.
      const row = await (await repos()).macrocycle.findByNumber(NON_CYCLE_PROGRAM, 1);
      expect(row).toMatchObject({ id: workout.macrocycleId, origin: 'non-cycle' });
      const macrocycles = (await inject('GET', `/programs/${PROGRAM_A}/macrocycles`)).json() as MacrocycleSummaryResponse[];
      expect(macrocycles.length).toBeGreaterThan(0);
      expect(macrocycles.map((m) => m.origin)).not.toContain('non-cycle');
    });
  });

  describe('History across a program switch', () => {
    it('still lists a workout recorded under the previous program', async () => {
      const { inject, start, list } = newUser();
      expect((await inject('POST', `/programs/${PROGRAM_A}/switch`)).statusCode).toBe(200);
      const workout = await start({ lift: 'Squat', weight: 405, reps: 1 });
      expect((await inject('POST', `/programs/${PROGRAM_B}/switch`)).statusCode).toBe(200);
      expect(await list()).toEqual(workout.records);
    });
  });

  describe('editing and deleting', () => {
    it('edits a set, deletes the workout and keeps the macrocycle row', async () => {
      const { inject, repos, start, list } = newUser();
      const kept = await start({ lift: 'Deadlift' });
      const workout = await start();
      const id = workout.records[0]?.id ?? '';

      const edited = await inject('PATCH', `/programs/${NON_CYCLE_PROGRAM}/lift-records/${id}`, { reps: 7 }, workout.macrocycleId);
      expect(edited.statusCode).toBe(200);
      expect((edited.json() as LiftRecordResponse).reps).toBe(7);

      expect((await inject('DELETE', `/non-cycle-workouts/${workout.workoutNum}`)).statusCode).toBe(400);
      expect((await inject('DELETE', `/non-cycle-workouts/${workout.workoutNum}`, undefined, workout.macrocycleId)).statusCode).toBe(204);
      expect(await list()).toEqual(kept.records);
      expect((await inject('GET', `/non-cycle-workouts/${workout.workoutNum}`)).statusCode).toBe(404);
      expect((await inject('DELETE', `/non-cycle-workouts/${workout.workoutNum}`, undefined, workout.macrocycleId)).statusCode).toBe(404);
      const row = await (await repos()).macrocycle.findByNumber(NON_CYCLE_PROGRAM, 1);
      expect(row).toMatchObject({ id: workout.macrocycleId, origin: 'non-cycle', status: 'unknown' });
    });

    it('leaves non-cycle workouts alone when a program’s current macrocycle is deleted', async () => {
      const { inject, start, list } = newUser();
      expect((await inject('POST', `/programs/${PROGRAM_A}/switch`)).statusCode).toBe(200);
      const workout = await start();
      expect((await inject('DELETE', `/programs/${PROGRAM_A}/macrocycles/current`)).statusCode).toBe(204);
      expect(await list()).toEqual(workout.records);
    });
  });

  describe('importing', () => {
    it('counts a file’s copy of a hand-recorded set as a duplicate', async () => {
      const { importCsv, start, list } = newUser();
      const workout = await start({ lift: 'Squat', setNum: 1, weight: 225, reps: 5 });
      const csv = ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes', `5-3-1,1,1,${TODAY},Squat,1,225,5,`].join('\n');
      const commit = await importCsv(PROGRAM_A, csv, 'import?mode=commit&destination=lift-records');
      expect(commit.statusCode).toBe(200);
      expect(commit.json()).toMatchObject({ created: 0, skipped: 1 });
      const direct = await importCsv(PROGRAM_A, csv, 'lift-records/import');
      expect(direct.statusCode).toBe(201);
      expect(direct.json()).toMatchObject({ written: 0, skipped: [expect.anything()] });
      expect(await list()).toEqual(workout.records);
    });

    it('stores a row whose Program is non-cycle as a non-cycle workout, which segmentation leaves out', async () => {
      const { inject, importCsv, list } = newUser();
      expect((await inject('POST', `/programs/${PROGRAM_A}/switch`)).statusCode).toBe(200);
      const maxesBefore = (await inject('GET', `/programs/${PROGRAM_A}/training-maxes`)).json() as TrainingMaxResponse[];
      // No Occurrence column, so it's not an export. The note would send it to Training Maxes
      // if it weren't non-cycle.
      const csv = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-05,Squat,1,225,5,',
        '5-3-1,1,2,2026-01-07,Bench P.,1,180,5,',
        'non-cycle,1,9,2026-01-06,Squat,1,315,1,1rm on vacation',
      ].join('\n');

      const segmented = segmentLiftHistory(parseLiftRecords(parseCsvText(csv)), {
        importDate: new Date('2026-01-10T00:00:00.000Z'),
        sourceProgram: PROGRAM_A,
      });
      expect(segmented.nonCycle.map((r) => r.weight)).toEqual([315]);
      const sessionDays = segmented.stretches.flatMap((s) => s.sessions.map((x) => x.date.toISOString().slice(0, 10)));
      expect(sessionDays).not.toContain('2026-01-06');

      const commit = await importCsv(PROGRAM_A, csv, 'import?mode=commit&destination=lift-records&splitDest=1');
      expect(commit.statusCode).toBe(200);
      const body = commit.json() as ImportCommitResponse;
      expect(body).toMatchObject({ created: 3 });
      expect(body.split).toBeUndefined();
      expect(await list()).toEqual([
        expect.objectContaining({ program: NON_CYCLE_PROGRAM, macrocycleNum: 1, workoutNum: 1, date: '2026-01-06', weight: 315, reps: 1 }),
      ]);
      expect((await inject('GET', `/programs/${PROGRAM_A}/training-maxes`)).json()).toEqual(maxesBefore);

      // Re-importing adds nothing, and undoing the import removes the non-cycle set too.
      expect((await importCsv(PROGRAM_A, csv, 'import?mode=commit&destination=lift-records')).json()).toMatchObject({ created: 0 });
      const undo = await inject('POST', `/programs/${PROGRAM_A}/import/${body.batchId}/undo`);
      expect(undo.statusCode).toBe(200);
      expect(undo.json()).toMatchObject({ restored: 3, skipped: 0 });
      expect(await list()).toEqual([]);
    });

    it("leaves a non-cycle row's lift out of the commit's lifts (#1273)", async () => {
      const { inject, importCsv } = newUser();
      expect((await inject('POST', `/programs/${PROGRAM_A}/switch`)).statusCode).toBe(200);
      // Only the non-cycle row has Dips, so a list that counted it would include `dips`.
      const csv = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-05,Squat,1,225,5,',
        'non-cycle,1,9,2026-01-06,Dips,1,0,10,',
      ].join('\n');

      const commit = await importCsv(PROGRAM_A, csv, 'import?mode=commit&destination=lift-records');
      expect(commit.statusCode).toBe(200);
      const body = commit.json() as ImportCommitResponse;
      expect(body.created).toBe(2);
      expect(body.lifts).toEqual(['back-squat']);
    });

    it('keeps a set recorded under a deleted workout’s number when the import that made it is undone', async () => {
      const { inject, importCsv, start, list } = newUser();
      const csv = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-05,Squat,1,225,5,',
        'non-cycle,1,9,2026-01-06,Squat,1,315,1,',
      ].join('\n');
      const commit = await importCsv(PROGRAM_A, csv, 'import?mode=commit&destination=lift-records');
      expect(commit.json()).toMatchObject({ created: 2 });
      const imported = (await inject('GET', '/non-cycle-workouts/1')).json() as NonCycleWorkoutResponse;
      expect((await inject('DELETE', '/non-cycle-workouts/1', undefined, imported.macrocycleId)).statusCode).toBe(204);

      // The new workout takes number 1 again, with the same date, lift and set as the deleted one.
      const redone = await start({ date: '2026-01-06', lift: 'Squat', setNum: 1, weight: 300, reps: 2 });
      expect(redone.workoutNum).toBe(1);
      const undo = await inject('POST', `/programs/${PROGRAM_A}/import/${(commit.json() as ImportCommitResponse).batchId}/undo`);
      expect(undo.statusCode).toBe(200);
      expect(undo.json()).toMatchObject({ restored: 1, skipped: 0 });
      expect(await list()).toEqual(redone.records);
    });
  });

  describe('the reference line', () => {
    it('returns the active program’s max and the reps last performed at the previous one', async () => {
      const { inject, repos } = newUser();
      const bundle = await repos();
      await bundle.trainingMax.saveTrainingMaxes(PROGRAM_A, [{ lift: 'Squat', weight: 205, dateUpdated: new Date('2026-02-01T00:00:00.000Z') }]);
      await bundle.trainingMaxHistory.appendHistoryEntries(PROGRAM_A, [
        { lift: 'Squat', weight: 200, reps: 1, date: new Date('2026-01-01T00:00:00.000Z'), isPR: false, source: 'program', goalMet: false },
        { lift: 'Squat', weight: 205, reps: 1, date: new Date('2026-02-01T00:00:00.000Z'), isPR: false, source: 'program', goalMet: false },
      ]);
      await bundle.liftRecord.appendLiftRecords(PROGRAM_B, [
        { program: PROGRAM_B, macrocycleNum: 1, workoutNum: 3, date: new Date('2026-01-20T00:00:00.000Z'), lift: 'Squat', setNum: 1, weight: 200, reps: 8, notes: '' },
      ]);
      const res = await inject('GET', `/programs/${PROGRAM_A}/non-cycle-reference?lift=Squat`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual<NonCycleReferenceResponse>({
        lift: 'Squat',
        reference: { trainingMax: 205, previous: { weight: 200, reps: 8 } },
      });
      const none = (await inject('GET', `/programs/${PROGRAM_A}/non-cycle-reference?lift=Deadlift`)).json() as NonCycleReferenceResponse;
      expect(none.reference).toBeNull();
      expect((await inject('GET', `/programs/${PROGRAM_A}/non-cycle-reference`)).statusCode).toBe(400);
    });
  });
});
