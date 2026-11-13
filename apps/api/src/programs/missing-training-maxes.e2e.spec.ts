import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { estimateOneRepMax, floorToIncrement, LiftRecord } from '@lifting-logbook/core';
import { MissingTrainingMaxResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

/** Lifts with logged sets and no training max (#1246, #1269), in-memory adapters. */
describe('GET /programs/:program/training-maxes/missing (e2e, in-memory adapters)', () => {
  const PROGRAM = '5-3-1';
  let app: NestFastifyApplication;
  let nextUser = 0;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const record = (fields: Partial<LiftRecord>): LiftRecord => ({
    program: PROGRAM,
    macrocycleNum: 1,
    workoutNum: 1,
    date: day('2026-11-03'),
    lift: 'Romanian Deadlift',
    setNum: 1,
    weight: 100,
    reps: 5,
    notes: '',
    ...fields,
  });

  /** A fresh user whose program has a Squat max and sets of Squat and Romanian Deadlift. */
  const seededUser = async () => {
    const user = `missing-max-e2e-${++nextUser}`;
    const repos: RepositoryBundle = await app
      .get<IRepositoryFactory>(REPOSITORY_FACTORY)
      .forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });
    await repos.trainingMax.saveTrainingMaxes(PROGRAM, [{ lift: 'Squat', weight: 300, dateUpdated: day('2026-10-01') }]);
    await repos.liftRecord.appendLiftRecords(PROGRAM, [
      record({ setNum: 1 }),
      record({ setNum: 2, weight: 90 }),
      record({ lift: 'Squat', weight: 315, reps: 3 }),
    ]);
    const get = async (query = '', program = PROGRAM) => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${program}/training-maxes/missing${query}`,
        headers: { authorization: `Bearer ${user}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json<MissingTrainingMaxResponse[]>();
    };
    return { repos, get };
  };

  it('lists only the lift with no max, with an estimate from its best set', async () => {
    const { get } = await seededUser();

    expect(await get()).toEqual([
      {
        lift: 'Romanian Deadlift',
        liftId: 'romanian-deadlift',
        lastLoggedDate: '2026-11-03',
        setCount: 2,
        estimate: {
          weight: floorToIncrement(0.9 * estimateOneRepMax(100, 5)),
          unit: 'lbs',
          from: { date: '2026-11-03', weight: 100, reps: 5 },
        },
        dismissed: false,
      },
    ]);
  });

  it('narrows the list to the lifts asked for, by any spelling', async () => {
    const { get } = await seededUser();

    expect(await get('?lifts=Squat')).toEqual([]);
    expect((await get('?lifts=romanian-deadlift')).map((m) => m.lift)).toEqual(['Romanian Deadlift']);
    expect((await get('?lifts=Squat&lifts=Romanian%20Deadlift')).map((m) => m.lift)).toEqual(['Romanian Deadlift']);
  });

  it('drops a lift once it has a max', async () => {
    const { repos, get } = await seededUser();
    await repos.trainingMax.saveTrainingMaxes(PROGRAM, [
      { lift: 'Romanian Deadlift', weight: 100, dateUpdated: day('2026-11-04') },
    ]);

    expect(await get()).toEqual([]);
  });

  it('reads only the program asked for', async () => {
    const { get } = await seededUser();

    expect(await get('', 'leangains')).toEqual([]);
    expect(await get()).toHaveLength(1);
  });
});
