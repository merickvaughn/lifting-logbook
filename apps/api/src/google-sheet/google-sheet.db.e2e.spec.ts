// Real-Postgres E2E for linking a Google Sheet (#1432, ADR-047). `app` boots against the restricted
// lifting_app role, so requests run through RlsInterceptor, the real PrismaRepositoryFactory and
// forced row-level security; `prisma` is the owner connection, used only to seed, read back and
// clean up. Google is a fake client and KMS a fake key wrapper, so nothing leaves the process.
//
// What this proves that the in-memory suite can't: each database step commits on its own. Under a
// per-request transaction, an error response rolls back every write the request made, so a
// rejected callback would restore its state and a 409 would undo the needs_relink it saved.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../adapters/prisma/prisma.service';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { GoogleApiError } from './google-sheet.client';
import { GOOGLE_SHEET_CLIENT, GOOGLE_TOKEN_CIPHER } from './google-sheet.service';
import { TokenCipher } from './token-cipher';
import { FAKE_CODE, FAKE_REFRESH_TOKEN, FakeGoogleSheetClient, FakeKeyWrapper } from './fakes';

// See programs.db.e2e.spec.ts (#567): headroom for a contended full-suite Windows run.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallback never runs (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_DATABASE_URL ?? '';

const USER_WRONG_STATE = 'db-e2e-gsheet-wrong-state';
const USER_LINK = 'db-e2e-gsheet-link';
const USER_REVOKED = 'db-e2e-gsheet-revoked';
const USERS = [USER_WRONG_STATE, USER_LINK, USER_REVOKED];

const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'fake-client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://web.example/settings/data/google-sheet/callback',
  GOOGLE_OAUTH_TOKEN_KMS_KEY_NAME: 'projects/p/locations/l/keyRings/r/cryptoKeys/google-oauth-token-kek',
};

async function cleanUsers(prisma: PrismaClient): Promise<void> {
  const where = { userId: { in: USERS } };
  await prisma.googleSheetLink.deleteMany({ where });
  await prisma.googleOauthRequest.deleteMany({ where });
}

describeOrSkip('Google Sheet link (e2e, real Postgres, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;
  const google = new FakeGoogleSheetClient();
  const saved: Record<string, string | undefined> = {};

  const call = (method: 'GET' | 'POST', path: string, user: string, payload?: object) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({ method, url: `/integrations/google-sheet${path}`, headers: { authorization: `Bearer ${user}` }, ...(payload && { payload }) });

  const authorize = async (user: string) => {
    const res = await call('POST', '/authorize', user);
    expect(res.statusCode).toBe(200);
    return new URL(res.json<{ url: string }>().url).searchParams.get('state')!;
  };

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
    prisma = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await cleanUsers(prisma);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_SHEET_CLIENT)
      .useValue(google)
      .overrideProvider(GOOGLE_TOKEN_CIPHER)
      .useValue(new TokenCipher(new FakeKeyWrapper()))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await cleanUsers(prisma).catch(() => undefined);
    await prisma?.$disconnect();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterEach(() => jest.restoreAllMocks());

  it('runs as the restricted role, not the owner', async () => {
    const rows = await app.get(PrismaService, { strict: false }).$queryRaw<
      Array<{ role: string; rolbypassrls: boolean }>
    >`SELECT current_user::text AS role, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ role: 'lifting_app', rolbypassrls: false }]);
  });

  it('deletes the attempt when the callback rejects a wrong state (decision 5)', async () => {
    await authorize(USER_WRONG_STATE);
    expect(await prisma.googleOauthRequest.count({ where: { userId: USER_WRONG_STATE } })).toBe(1);
    const res = await call('POST', '/callback', USER_WRONG_STATE, { code: FAKE_CODE, state: 'not-the-state' });
    expect(res.statusCode).toBe(400);
    expect(await prisma.googleOauthRequest.count({ where: { userId: USER_WRONG_STATE } })).toBe(0);
  });

  it('stores a linked row with the token encrypted, and uses up the state', async () => {
    const state = await authorize(USER_LINK);
    const res = await call('POST', '/callback', USER_LINK, { code: FAKE_CODE, state });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'linked' });

    const row = (await prisma.googleSheetLink.findUnique({ where: { userId: USER_LINK } }))!;
    expect(row).toMatchObject({ status: 'linked', lastErrorCode: null });
    expect(Buffer.from(row.refreshTokenCiphertext!).toString('utf8')).not.toContain(FAKE_REFRESH_TOKEN);
    const token = {
      ciphertext: Buffer.from(row.refreshTokenCiphertext!),
      wrappedKey: Buffer.from(row.refreshTokenDekCiphertext!),
      nonce: Buffer.from(row.refreshTokenNonce!),
    };
    expect(await new TokenCipher(new FakeKeyWrapper()).decrypt(USER_LINK, token)).toMatch(FAKE_REFRESH_TOKEN);
    expect(await prisma.googleOauthRequest.count({ where: { userId: USER_LINK } })).toBe(0);
  });

  it('keeps needs_relink saved when POST /sheet answers 409 for invalid_grant (decision 11)', async () => {
    const state = await authorize(USER_REVOKED);
    expect((await call('POST', '/callback', USER_REVOKED, { code: FAKE_CODE, state })).statusCode).toBe(200);
    // As a mirror run would record it (decision 12).
    await prisma.googleSheetLink.update({ where: { userId: USER_REVOKED }, data: { status: 'sheet_missing' } });
    jest.spyOn(google, 'refreshAccessToken').mockRejectedValueOnce(new GoogleApiError(400, 'invalid_grant'));

    const res = await call('POST', '/sheet', USER_REVOKED);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'google-sheet-needs-relink' });
    expect(await prisma.googleSheetLink.findUnique({ where: { userId: USER_REVOKED } })).toMatchObject({
      status: 'needs_relink',
      lastErrorCode: 'invalid_grant',
      refreshTokenCiphertext: null,
      refreshTokenDekCiphertext: null,
      refreshTokenNonce: null,
    });
  });
});
