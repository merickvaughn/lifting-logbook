import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { MACROCYCLE_ID_HEADER, WorkoutResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

/**
 * `DELETE /programs/:p/lift-records/:id` (#1496), in-memory adapters: how the complex card removes
 * a round. The macrocycle id checks it shares with every page write are in
 * macrocycle-id.e2e.spec.ts and macrocycle-history.e2e.spec.ts, and the Postgres run in
 * barbell-complex.db.e2e.spec.ts.
 */
describe('DELETE lift-records/:id (e2e, in-memory adapters)', () => {
  const PROGRAM = '5-3-1';
  const base = `/programs/${PROGRAM}`;
  let app: NestFastifyApplication;

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

  /** Each test acts as its own users, so the in-memory store starts empty. */
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
    expect((await inject('POST', `${base}/macrocycles/initialize`, { macrocycleDate: '2026-01-05' })).statusCode).toBe(201);
    const id = (((await inject('GET', `${base}/workouts/1`)).json()) as WorkoutResponse).macrocycleId;
    if (typeof id !== 'string') throw new Error('the workout read returned no macrocycle id');
    const records = async () =>
      (
        await app
          .get<IRepositoryFactory>(REPOSITORY_FACTORY)
          .forUser({ id: user, email: `${user}@example.com`, provider: 'dev' })
      ).liftRecord.getLiftRecords(PROGRAM, 1);
    const log = async (setNum: number) => {
      const body = { macrocycleNum: 1, workoutNum: 1, date: '2026-01-05', lift: 'Squat', setNum, weight: 225, reps: 5 };
      const res = await inject('POST', `${base}/lift-records`, body, id);
      expect(res.statusCode).toBe(201);
      return (res.json() as { id: string }).id;
    };
    const remove = (recordId: string, macrocycleId: string | undefined = id) =>
      inject('DELETE', `${base}/lift-records/${encodeURIComponent(recordId)}`, undefined, macrocycleId);
    return { id, records, log, remove };
  };

  it('answers 204 and removes only that set', async () => {
    const user = await as('delete-ok');
    const first = await user.log(1);
    await user.log(2);

    const res = await user.remove(first);

    expect(res.statusCode).toBe(204);
    expect((await user.records()).map((r) => r.setNum)).toEqual([2]);
    expect((await user.remove(first)).statusCode).toBe(404);
  });

  it('answers 404 for an id with no set and for an id that is not a set id, removing nothing', async () => {
    const user = await as('delete-unknown');
    await user.log(1);

    expect((await user.remove(`${PROGRAM}-1-1-20260105-Squat-9`)).statusCode).toBe(404);
    expect((await user.remove('not-a-set-id')).statusCode).toBe(404);
    expect(await user.records()).toHaveLength(1);
  });

  it("doesn't delete another user's set, whichever macrocycle id it sends", async () => {
    const owner = await as('delete-owner');
    const other = await as('delete-other');
    const recordId = await owner.log(1);

    expect((await other.remove(recordId)).statusCode).toBe(404);
    const withOwnersId = await other.remove(recordId, owner.id);
    expect(withOwnersId.statusCode).toBe(404);
    expect(withOwnersId.json()).toMatchObject({ code: 'macrocycle-not-found' });
    expect(await owner.records()).toHaveLength(1);
  });
});
