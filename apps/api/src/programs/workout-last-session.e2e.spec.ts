import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { LiftRecord } from '@lifting-logbook/core';
import { WorkoutResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

/** Each lift's last session on `GET /workouts/:n` (#1252), in-memory adapters. */
describe('GET /programs/:program/workouts/:workoutNum — lastSession (e2e, in-memory adapters)', () => {
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
  const sets = (workoutNum: number, date: string, lift: string, reps: number[], fields: Partial<LiftRecord> = {}): LiftRecord[] =>
    reps.map((r, i) => ({
      program: PROGRAM,
      macrocycleNum: 1,
      workoutNum,
      date: day(date),
      lift,
      setNum: i + 1,
      weight: 30,
      reps: r,
      notes: '',
      ...fields,
    }));

  /** A fresh user with `records` stored, and a reader of their workouts. */
  const seededUser = async (records: LiftRecord[]) => {
    const user = `last-session-e2e-${++nextUser}`;
    const repos = await app
      .get<IRepositoryFactory>(REPOSITORY_FACTORY)
      .forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });
    await repos.liftRecord.appendLiftRecords(PROGRAM, records);
    return async (workoutNum: number) => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${PROGRAM}/workouts/${workoutNum}`,
        headers: { authorization: `Bearer ${user}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json<WorkoutResponse>();
    };
  };

  it('gives the later of two earlier workouts’ reps, under another spelling, leaving out this workout and a second occurrence', async () => {
    const getWorkout = await seededUser([
      ...sets(1, '2026-11-02', 'Cable Curl', [12, 12, 12]),
      // The later session, stored by catalog id.
      ...sets(2, '2026-11-04', 'cable-curl', [12, 11, 10]),
      // A second occurrence of the lift in that workout, which doesn't count.
      ...sets(2, '2026-11-04', 'Cable Curl', [6], { occurrence: 1 }),
      // A workout dated after this one, which doesn't count either.
      ...sets(5, '2026-11-09', 'Cable Curl', [8, 8, 8]),
      // This workout's own set.
      ...sets(3, '2026-11-06', 'Cable Curl', [9]),
      ...sets(3, '2026-11-06', 'Squat', [5]),
    ]);

    const workout = await getWorkout(3);

    const curl = workout.lifts.find((l) => l.lift === 'Cable Curl');
    expect(curl?.lastSession).toEqual({ date: '2026-11-04', reps: [12, 11, 10] });
    // A lift never logged before has none.
    expect(workout.lifts.find((l) => l.lift === 'Squat')).not.toHaveProperty('lastSession');
  });

  it('counts a workout dated the same day, but not the workout itself', async () => {
    const getWorkout = await seededUser([
      ...sets(1, '2026-11-02', 'Cable Curl', [12, 12]),
      ...sets(2, '2026-11-02', 'Cable Curl', [10, 9]),
    ]);

    const curlOf = (workout: WorkoutResponse) => workout.lifts.find((l) => l.lift === 'Cable Curl');
    expect(curlOf(await getWorkout(1))?.lastSession).toEqual({ date: '2026-11-02', reps: [10, 9] });
    expect(curlOf(await getWorkout(2))?.lastSession).toEqual({ date: '2026-11-02', reps: [12, 12] });
  });
});
