import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

// Regression coverage for #1029: GET/PATCH /users/me/settings 500'd with no DATABASE_URL
// because the controller injected PrismaService directly (null in this in-memory jest
// environment — see jest.env.setup.js) instead of resolving IUserSettingsRepository
// through the repository factory like the other factory-backed controllers (e.g.
// BodyWeightController). This suite runs the way `npm run dev -w @lifting-logbook/api`
// does with no DATABASE_URL set: the in-memory adapters, not a Prisma mock.
describe('User Settings HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const authFor = (token: string) => ({ authorization: `Bearer ${token}` });

  const get = (url: string, token: string) =>
    app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers: authFor(token) });

  const patchJson = (url: string, token: string, body: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'PATCH',
      url,
      headers: { 'content-type': 'application/json', ...authFor(token) },
      payload: JSON.stringify(body),
    });

  it('GET /users/me/settings returns 401 without auth', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/users/me/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /users/me/settings returns empty settings for a fresh user without a database', async () => {
    const res = await get('/users/me/settings', 'settings-fresh-user');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: null,
      unit: null,
    });
  });

  it('PATCH /users/me/settings persists a patch without a database and GET reflects it', async () => {
    const token = 'settings-roundtrip-user';

    const patched = await patchJson('/users/me/settings', token, {
      activeProgram: '5-3-1',
      unit: 'kg',
      defaultWeightIncrement: 0.625,
      workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({
      activeProgram: '5-3-1',
      workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
      defaultWeightIncrement: 0.625,
      unit: 'kg',
    });

    const fetched = await get('/users/me/settings', token);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(patched.json());
  });

  it('PATCH /users/me/settings clears a field with an explicit null', async () => {
    const token = 'settings-clear-user';

    // Assert the setup write actually landed — otherwise a broken setup PATCH would still
    // leave `unit` at its already-null default, and the clear assertion below would pass
    // without ever exercising a clear.
    const set = await patchJson('/users/me/settings', token, { unit: 'kg' });
    expect(set.statusCode).toBe(200);
    expect(set.json().unit).toBe('kg');

    const cleared = await patchJson('/users/me/settings', token, { unit: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().unit).toBeNull();
  });
});
