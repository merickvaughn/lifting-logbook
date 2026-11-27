import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

// Regression coverage for #1479: /programs/custom 500'd with no DATABASE_URL because the
// controller called this.prisma.clientForRequest() on a null PrismaService (null in this
// in-memory jest environment — see jest.env.setup.js). Custom programs are Prisma-only
// (docs/domain-model.md D17), so with no database there are none to list, and writes
// can't be stored.
describe('Custom programs HTTP (e2e, in-memory adapters)', () => {
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

  const TOKEN = 'custom-programs-in-memory-user';
  const ID = '00000000-0000-4000-8000-000000000001';
  const BODY = {
    name: 'In-memory program',
    specs: [
      {
        week: 1,
        offset: 0,
        lift: 'Bench Press',
        increment: 5,
        order: 1,
        sets: 3,
        reps: 5,
        amrap: false,
        warmUpPct: '0.4,0.5,0.6',
        wtDecrementPct: 0.1,
        activation: 'none',
      },
    ],
  };

  const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  it('GET /programs/custom returns an empty list without a database', async () => {
    const res = await request('GET', '/programs/custom');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('GET /programs/custom/:id returns 404 without a database', async () => {
    const res = await request('GET', `/programs/custom/${ID}`);
    expect(res.statusCode).toBe(404);
  });

  it.each([
    ['POST', '/programs/custom'],
    ['PUT', `/programs/custom/${ID}`],
    ['DELETE', `/programs/custom/${ID}`],
  ] as const)('%s %s returns 503 with a clear message without a database', async (method, url) => {
    const res = await request(method, url, method === 'DELETE' ? undefined : BODY);
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toBe('Custom programs need a database');
  });
});
