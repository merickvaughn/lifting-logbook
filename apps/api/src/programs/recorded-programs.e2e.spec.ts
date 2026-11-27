import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { LiftRecord } from '@lifting-logbook/core';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

/**
 * GET /users/me/recorded-programs (#1454), in-memory adapters: the programs holding the user's
 * sets, so the web can list a template the lifter can't pick but imported into.
 */
describe('Recorded programs HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (user?: string) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/users/me/recorded-programs', headers: user ? { authorization: `Bearer ${user}` } : {} });

  const set = (program: string): LiftRecord => ({
    program,
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date('2025-03-03T00:00:00.000Z'),
    lift: 'Squat',
    setNum: 1,
    weight: 200,
    reps: 5,
    notes: '',
  });

  const seed = async (user: string, programs: string[]) => {
    const { liftRecord } = await app
      .get<IRepositoryFactory>(REPOSITORY_FACTORY)
      .forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });
    for (const program of programs) await liftRecord.appendLiftRecords(program, [set(program)]);
  };

  it('returns 401 without auth', async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it('lists none for a user with no sets', async () => {
    const res = await get('recorded-fresh-user');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('lists every program holding a set, sorted, without the non-cycle one', async () => {
    await seed('recorded-importer', ['rpt', '531', NON_CYCLE_PROGRAM]);
    const res = await get('recorded-importer');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(['531', 'rpt']);
  });

  // #1304: an imported macrocycle with no sets still holds history History must reach.
  it('lists a template holding only an imported macrocycle, though the user is on another program', async () => {
    const repos = await app
      .get<IRepositoryFactory>(REPOSITORY_FACTORY)
      .forUser({ id: 'recorded-macrocycle-only', email: 'recorded-macrocycle-only@example.com', provider: 'dev' });
    await repos.userSettings.upsertSettings({ activeProgram: 'rpt' });
    await repos.macrocycle.create({
      program: '5-3-1',
      macrocycleNum: 1,
      startDate: new Date('2024-01-01T00:00:00.000Z'),
      endDate: new Date('2024-01-26T00:00:00.000Z'),
      status: 'completed',
      origin: 'imported',
    });
    await repos.macrocycle.create({
      program: NON_CYCLE_PROGRAM,
      macrocycleNum: 1,
      startDate: new Date('2024-02-01T00:00:00.000Z'),
      status: 'completed',
      origin: 'imported',
    });

    const res = await get('recorded-macrocycle-only');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(['5-3-1']);
  });

  it("doesn't list another user's programs", async () => {
    await seed('recorded-other', ['leangains']);
    expect((await get('recorded-someone-else')).json()).toEqual([]);
  });
});
