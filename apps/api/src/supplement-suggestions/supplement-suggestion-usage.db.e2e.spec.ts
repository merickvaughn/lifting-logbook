// Real-Postgres E2E for the hourly supplement AI suggestion count (#1381).
//
// Two Prisma clients connect as the restricted lifting_app role, standing in for two API
// instances, and race for one lifter's requests. The per-user advisory lock must let exactly the
// hourly limit through, however the requests interleave. Postgres is provisioned by
// jest.global-setup.js (Testcontainers locally; CI passthrough).
//
// The last describe boots the app against the same role, so the suggestion routes run through
// RlsInterceptor: the outgoing call must not sit inside a request transaction, and the count must
// still be written as the lifter.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '@prisma/client';
import { IMPORT_SUGGESTION_HOURLY_LIMIT, SUPPLEMENT_SUGGESTION_HOURLY_LIMIT } from '@lifting-logbook/types';
import { RLS_TX_CLIENT, RLS_USER_ID_KEY } from '../adapters/prisma/rls-context';
import { AppModule } from '../app.module';
import { PrismaImportSuggestionUsage, SUPPLEMENT_COUNT } from '../import-suggestions/import-suggestion-usage';
import type { IImportSuggestionProvider, ISupplementLabelLookup } from '../ports';
import { IMPORT_SUGGESTION_PROVIDER, SUPPLEMENT_LABEL_LOOKUP } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallbacks never run (as in rls.db.e2e.spec.ts).
const APP_URL = APP_ROLE_URL ?? '';
const OWNER_URL = OWNER_DATABASE_URL ?? '';

// See rls.db.e2e.spec.ts: a contended Windows run can pass Jest's 5s hook default (#567).
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER = 'supplement-suggestion-usage-e2e-lifter';
const OTHER = 'supplement-suggestion-usage-e2e-other';
const ROUTE_USER = 'supplement-suggestion-usage-e2e-route';
const USERS = [USER, OTHER, ROUTE_USER];

async function cleanUsers(owner: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await owner.supplementSuggestionUsage.deleteMany({ where });
  await owner.importSuggestionUsage.deleteMany({ where });
}

describeOrSkip('Supplement suggestion hourly count (#1381, e2e, lifting_app role)', () => {
  let owner: PrismaClient;
  let first: PrismaClient;
  let second: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    first = new PrismaClient({ datasources: { db: { url: APP_URL } } });
    second = new PrismaClient({ datasources: { db: { url: APP_URL } } });
    await Promise.all([first.$connect(), second.$connect()]);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanUsers(owner);
  });

  afterAll(async () => {
    await (owner ? cleanUsers(owner) : Promise.resolve()).catch(() => undefined);
    await Promise.all([owner?.$disconnect(), first?.$disconnect(), second?.$disconnect()]);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('runs as the restricted role', async () => {
    const rows = await first.$queryRaw<Array<{ role: string; rolbypassrls: boolean }>>`
      SELECT current_user::text AS role, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ role: 'lifting_app', rolbypassrls: false }]);
  });

  it(`lets exactly ${SUPPLEMENT_SUGGESTION_HOURLY_LIMIT} of 40 concurrent requests from two instances through`, async () => {
    const instances = [new PrismaImportSuggestionUsage(first, SUPPLEMENT_COUNT), new PrismaImportSuggestionUsage(second, SUPPLEMENT_COUNT)];
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => instances[i % 2]?.tryConsume(USER, now, SUPPLEMENT_SUGGESTION_HOURLY_LIMIT)),
    );

    expect(results.filter((r) => r?.allowed)).toHaveLength(SUPPLEMENT_SUGGESTION_HOURLY_LIMIT);
    expect(await owner.supplementSuggestionUsage.count({ where: { userId: USER } })).toBe(SUPPLEMENT_SUGGESTION_HOURLY_LIMIT);
  });

  it('counts each lifter apart, and frees a request an hour after it was made', async () => {
    const usage = new PrismaImportSuggestionUsage(first, SUPPLEMENT_COUNT);
    const start = new Date('2026-11-14T10:00:00Z');
    for (let i = 0; i < SUPPLEMENT_SUGGESTION_HOURLY_LIMIT; i++) {
      expect(await usage.tryConsume(USER, new Date(start.getTime() + i * 60_000), SUPPLEMENT_SUGGESTION_HOURLY_LIMIT)).toEqual({
        allowed: true,
      });
    }

    const halfPast = new Date(start.getTime() + 30 * 60_000);
    expect(await usage.tryConsume(USER, halfPast, SUPPLEMENT_SUGGESTION_HOURLY_LIMIT)).toEqual({
      allowed: false,
      retryAt: new Date(start.getTime() + 60 * 60_000),
    });
    expect(await usage.tryConsume(OTHER, halfPast, SUPPLEMENT_SUGGESTION_HOURLY_LIMIT)).toEqual({ allowed: true });

    expect(await usage.tryConsume(USER, new Date(start.getTime() + 60 * 60_000), SUPPLEMENT_SUGGESTION_HOURLY_LIMIT)).toEqual({
      allowed: true,
    });
    // The expired request was cleared, and only this lifter's rows were touched.
    expect(await owner.supplementSuggestionUsage.count({ where: { userId: USER } })).toBe(SUPPLEMENT_SUGGESTION_HOURLY_LIMIT);
    expect(await owner.supplementSuggestionUsage.count({ where: { userId: OTHER } })).toBe(1);
  });

  it('counts apart from the import suggestions, in its own table', async () => {
    const start = new Date('2026-11-14T10:00:00Z');
    const imports = new PrismaImportSuggestionUsage(first);
    for (let i = 0; i < IMPORT_SUGGESTION_HOURLY_LIMIT; i++) {
      expect(await imports.tryConsume(USER, start, IMPORT_SUGGESTION_HOURLY_LIMIT)).toEqual({ allowed: true });
    }
    expect(await imports.tryConsume(USER, start, IMPORT_SUGGESTION_HOURLY_LIMIT)).toMatchObject({ allowed: false });
    // An import request older than the hour, which only the import count's own cleanup may remove.
    await owner.importSuggestionUsage.create({ data: { userId: USER, usedAt: new Date(start.getTime() - 2 * 60 * 60_000) } });

    // The import allowance is used up, and the supplement one is untouched by it.
    const supplements = new PrismaImportSuggestionUsage(second, SUPPLEMENT_COUNT);
    for (let i = 0; i < SUPPLEMENT_SUGGESTION_HOURLY_LIMIT; i++) {
      expect(await supplements.tryConsume(USER, start, SUPPLEMENT_SUGGESTION_HOURLY_LIMIT)).toEqual({ allowed: true });
    }

    expect(await owner.importSuggestionUsage.count({ where: { userId: USER } })).toBe(IMPORT_SUGGESTION_HOURLY_LIMIT + 1);
    expect(await owner.supplementSuggestionUsage.count({ where: { userId: USER } })).toBe(SUPPLEMENT_SUGGESTION_HOURLY_LIMIT);
  });

  describe('through the routes', () => {
    let app: NestFastifyApplication;
    /** What CLS held while each outgoing call ran: a request transaction, and the lifter for one of its own. */
    const seen: Array<{ call: string; tx: unknown; userId: unknown }> = [];

    beforeAll(async () => {
      // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
      process.env.DATABASE_URL = APP_ROLE_URL;
      // Read when a call runs, which is after `app` is set below.
      const record = (call: string) => {
        const cls = app.get(ClsService);
        seen.push({ call, tx: cls.get(RLS_TX_CLIENT), userId: cls.get(RLS_USER_ID_KEY) });
      };
      const provider: IImportSuggestionProvider = {
        kind: 'anthropic',
        label: 'Fake',
        suggest: async () => {
          record('ai');
          return { output: { suggestion: { name: 'Fake', ingredients: [] } }, inputTokens: 1, outputTokens: 1, truncated: false };
        },
      };
      const labels: ISupplementLabelLookup = {
        lookup: async () => {
          record('label');
          return [];
        },
      };
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(IMPORT_SUGGESTION_PROVIDER)
        .useValue(provider)
        .overrideProvider(SUPPLEMENT_LABEL_LOOKUP)
        .useValue(labels)
        .compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
      app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    }, DB_E2E_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await app?.close();
    }, DB_E2E_HOOK_TIMEOUT_MS);

    const post = (url: string, name: string) =>
      app.getHttpAdapter().getInstance().inject({ method: 'POST', url, headers: { authorization: `Bearer ${ROUTE_USER}` }, payload: { name } });

    it('calls out with no request transaction open, and counts the AI request as the lifter', async () => {
      seen.length = 0;
      expect((await post('/supplements/label-lookup', 'Creatine')).statusCode).toBe(200);
      const ai = await post('/supplements/ai-suggestion', 'Creatine');
      expect(ai.statusCode).toBe(200);
      expect(ai.json()).toMatchObject({ status: 'ready' });

      // A request transaction open here would be held for the whole call (up to 60 s), past its
      // 15 s timeout (P2028).
      expect(seen).toEqual([
        { call: 'label', tx: undefined, userId: ROUTE_USER },
        { call: 'ai', tx: undefined, userId: ROUTE_USER },
      ]);
      // Written under forced RLS as the lifter, in the count's own transaction.
      expect(await owner.supplementSuggestionUsage.count({ where: { userId: ROUTE_USER } })).toBe(1);
    });
  });
});
