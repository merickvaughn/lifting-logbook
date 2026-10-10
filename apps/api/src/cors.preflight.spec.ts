import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { resolveCorsOrigins } from './cors.config';

// Deterministic, network-free proof that `app.enableCors()` on the Fastify adapter
// actually answers a CORS preflight with the allowlist from cors.config.ts. This
// exercises the real wiring main.ts uses (enableCors → @fastify/cors) via Fastify's
// `inject()` (light-my-request), so it needs no DB, no deployment, and — unlike the
// staging E2E — no shared, concurrently-overwritten Cloud Run service. The
// cors.config.spec.ts sibling covers origin *resolution*; this covers that the
// resolved list is honored on the wire (issue #766 / ADR-032).
@Controller('programs/:program')
class StubRescheduleController {
  @Get('macrocycles/:macrocycleNum/workouts/:workoutNum/ping')
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [StubRescheduleController] })
class CorsProbeModule {}

describe('CORS preflight wiring (enableCors + Fastify adapter)', () => {
  let app: NestFastifyApplication;
  // Use the deployed (production) allowlist so the assertions pin real origins.
  const ALLOWED = 'https://liftinglogbook.com';
  const ALLOWED_CLOUD_RUN =
    'https://lifting-logbook-stg-web-910635705567.us-central1.run.app';

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      CorsProbeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.enableCors({
      origin: resolveCorsOrigins(undefined, 'production'),
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 3600,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function preflight(origin: string) {
    return app.getHttpAdapter().getInstance().inject({
      method: 'OPTIONS',
      url: '/programs/5-3-1/macrocycles/1/workouts/1/reschedule',
      headers: {
        origin,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
  }

  it('answers a preflight from the custom domain with Access-Control-Allow-Origin', async () => {
    const res = await preflight(ALLOWED);
    expect([200, 204]).toContain(res.statusCode);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    // The browser's actual request method + headers are echoed as allowed.
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(
      String(res.headers['access-control-allow-headers']).toLowerCase(),
    ).toContain('authorization');
  });

  it('answers a preflight from the project-number Cloud Run origin (the one the staging suite loads from)', async () => {
    const res = await preflight(ALLOWED_CLOUD_RUN);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_CLOUD_RUN);
  });

  it('does NOT reflect a disallowed origin', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
