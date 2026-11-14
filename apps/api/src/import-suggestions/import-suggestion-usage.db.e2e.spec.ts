// Real-Postgres E2E for the hourly import suggestion count (#1174, proposal decision 12).
//
// Two Prisma clients connect as the restricted lifting_app role, standing in for two API
// instances, and race for one lifter's requests. The per-user advisory lock must let exactly the
// hourly limit through, however the requests interleave. Postgres is provisioned by
// jest.global-setup.js (Testcontainers locally; CI passthrough).
import { PrismaClient } from '@prisma/client';
import { IMPORT_SUGGESTION_HOURLY_LIMIT } from '@lifting-logbook/types';
import { PrismaImportSuggestionUsage } from './import-suggestion-usage';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallbacks never run (as in rls.db.e2e.spec.ts).
const APP_URL = APP_ROLE_URL ?? '';
const OWNER_URL = OWNER_DATABASE_URL ?? '';

// See rls.db.e2e.spec.ts: a contended Windows run can pass Jest's 5s hook default (#567).
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER = 'import-suggestion-usage-e2e-lifter';
const OTHER = 'import-suggestion-usage-e2e-other';

describeOrSkip('Import suggestion hourly count (#1174, e2e, lifting_app role)', () => {
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
    await owner.importSuggestionUsage.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
  });

  afterAll(async () => {
    await owner?.importSuggestionUsage.deleteMany({ where: { userId: { in: [USER, OTHER] } } }).catch(() => undefined);
    await Promise.all([owner?.$disconnect(), first?.$disconnect(), second?.$disconnect()]);
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('runs as the restricted role', async () => {
    const rows = await first.$queryRaw<Array<{ role: string; rolbypassrls: boolean }>>`
      SELECT current_user::text AS role, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ role: 'lifting_app', rolbypassrls: false }]);
  });

  it(`lets exactly ${IMPORT_SUGGESTION_HOURLY_LIMIT} of 20 concurrent requests from two instances through`, async () => {
    const instances = [new PrismaImportSuggestionUsage(first), new PrismaImportSuggestionUsage(second)];
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => instances[i % 2]?.tryConsume(USER, now, IMPORT_SUGGESTION_HOURLY_LIMIT)),
    );

    expect(results.filter((r) => r?.allowed)).toHaveLength(IMPORT_SUGGESTION_HOURLY_LIMIT);
    expect(await owner.importSuggestionUsage.count({ where: { userId: USER } })).toBe(IMPORT_SUGGESTION_HOURLY_LIMIT);
  });

  it('counts each lifter apart, and frees a request an hour after it was made', async () => {
    const usage = new PrismaImportSuggestionUsage(first);
    const start = new Date('2026-11-14T10:00:00Z');
    for (let i = 0; i < IMPORT_SUGGESTION_HOURLY_LIMIT; i++) {
      expect(await usage.tryConsume(USER, new Date(start.getTime() + i * 60_000), IMPORT_SUGGESTION_HOURLY_LIMIT)).toEqual({
        allowed: true,
      });
    }

    const halfPast = new Date(start.getTime() + 30 * 60_000);
    expect(await usage.tryConsume(USER, halfPast, IMPORT_SUGGESTION_HOURLY_LIMIT)).toEqual({
      allowed: false,
      retryAt: new Date(start.getTime() + 60 * 60_000),
    });
    expect(await usage.tryConsume(OTHER, halfPast, IMPORT_SUGGESTION_HOURLY_LIMIT)).toEqual({ allowed: true });

    expect(await usage.tryConsume(USER, new Date(start.getTime() + 60 * 60_000), IMPORT_SUGGESTION_HOURLY_LIMIT)).toEqual({
      allowed: true,
    });
    // The expired request was cleared, and only this lifter's rows were touched.
    expect(await owner.importSuggestionUsage.count({ where: { userId: USER } })).toBe(IMPORT_SUGGESTION_HOURLY_LIMIT);
    expect(await owner.importSuggestionUsage.count({ where: { userId: OTHER } })).toBe(1);
  });
});
