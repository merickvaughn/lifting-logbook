import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { InMemoryGoogleSheetLinkRepository } from '../adapters/in-memory/google-sheet-link.adapter';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { IRepositoryFactory } from '../ports/factory';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DRIVE_FILE_SCOPE, GoogleApiError, IGoogleSheetClient } from './google-sheet.client';
import { GOOGLE_PERMISSIONS_URL, GOOGLE_SHEET_CLIENT, GOOGLE_TOKEN_CIPHER } from './google-sheet.service';
import { TokenCipher } from './token-cipher';
import {
  FAKE_CODE,
  FAKE_REFRESH_TOKEN,
  FakeGoogleSheetClient,
  FakeKeyWrapper,
  failingGoogleClient,
} from './fakes';

/**
 * In-memory E2E for linking a Google Sheet (#1432, ADR-047). Google is a fake client and KMS a
 * fake key wrapper, so nothing leaves the process.
 */

const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'fake-client-secret', GOOGLE_OAUTH_REDIRECT_URI: 'https://web.example/settings/data/google-sheet/callback' };
const saved: Record<string, string | undefined> = {};

async function boot(google: IGoogleSheetClient): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GOOGLE_SHEET_CLIENT)
    .useValue(google)
    .overrideProvider(GOOGLE_TOKEN_CIPHER)
    .useValue(new TokenCipher(new FakeKeyWrapper()))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const call = (app: NestFastifyApplication, method: 'GET' | 'POST' | 'DELETE', path: string, user: string, payload?: object) =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({ method, url: `/integrations/google-sheet${path}`, headers: { authorization: `Bearer ${user}` }, ...(payload && { payload }) });

/** Runs authorize and returns the URL's query and the state Google would send back. */
async function authorize(app: NestFastifyApplication, user: string) {
  const res = await call(app, 'POST', '/authorize', user);
  expect(res.statusCode).toBe(200);
  const url = new URL(res.json<{ url: string }>().url);
  return { url, state: url.searchParams.get('state')! };
}

async function link(app: NestFastifyApplication, user: string) {
  const { state } = await authorize(app, user);
  return call(app, 'POST', '/callback', user, { code: FAKE_CODE, state });
}

const repoOf = async (app: NestFastifyApplication, user: string) =>
  (await app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user } as never))
    .googleSheetLink as InMemoryGoogleSheetLinkRepository;

describe('Google Sheet link (e2e, in-memory)', () => {
  let app: NestFastifyApplication;
  let google: FakeGoogleSheetClient;

  beforeAll(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    google = new FakeGoogleSheetClient();
    app = await boot(google);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    await app.close();
  });

  it('requires a signed-in user', async () => {
    const res = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/integrations/google-sheet/authorize' });
    expect(res.statusCode).toBe(401);
  });

  describe('authorize', () => {
    it("returns Google's URL with drive.file, offline access, consent, state and an S256 challenge", async () => {
      const { url, state } = await authorize(app, 'gs-auth');
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      const q = Object.fromEntries(url.searchParams);
      expect(q).toMatchObject({
        client_id: ENV.GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: ENV.GOOGLE_OAUTH_REDIRECT_URI,
        response_type: 'code',
        scope: DRIVE_FILE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        code_challenge_method: 'S256',
      });
      expect(Buffer.from(state, 'base64url')).toHaveLength(32);
      expect(q.client_secret).toBeUndefined();

      // The stored row holds the state's hash and the verifier the challenge was made from.
      const request = (await (await repoOf(app, 'gs-auth')).takeOauthRequest())!;
      expect(request.stateHash.equals(createHash('sha256').update(state).digest())).toBe(true);
      expect(Buffer.from(request.codeVerifier, 'base64url')).toHaveLength(32);
      expect(createHash('sha256').update(request.codeVerifier).digest('base64url')).toBe(q.code_challenge);
      expect(request.expiresAt.getTime() - Date.now()).toBeGreaterThan(9.9 * 60_000);
      expect(request.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    });

    it('answers 503 google-sheet-unconfigured with no client ID', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      try {
        const res = await call(app, 'POST', '/authorize', 'gs-unconfigured');
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ error: 'google-sheet-unconfigured' });
        expect((await call(app, 'GET', '', 'gs-unconfigured')).json()).toMatchObject({ configured: false });
      } finally {
        process.env.GOOGLE_OAUTH_CLIENT_ID = ENV.GOOGLE_OAUTH_CLIENT_ID;
      }
    });
  });

  describe('callback', () => {
    it('exchanges the code with the secret and verifier, creates the sheet and stores the token encrypted', async () => {
      const res = await link(app, 'gs-ok');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        configured: true,
        status: 'linked',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        lastMirroredAt: null,
      });
      const exchange = google.calls.find((c) => c.method === 'exchangeCode')!;
      expect(exchange.args[0]).toMatchObject({ clientSecret: ENV.GOOGLE_OAUTH_CLIENT_SECRET });
      expect(exchange.args[1]).toBe(FAKE_CODE);
      expect(google.calls.map((c) => c.method)).toEqual(['exchangeCode', 'createSpreadsheet']);

      const stored = (await (await repoOf(app, 'gs-ok')).getLink())!;
      expect(stored.token!.ciphertext.toString('utf8')).not.toContain(FAKE_REFRESH_TOKEN);
      expect(await new TokenCipher(new FakeKeyWrapper()).decrypt('gs-ok', stored.token!)).toBe(FAKE_REFRESH_TOKEN);
      // The state is single-use.
      expect(await (await repoOf(app, 'gs-ok')).takeOauthRequest()).toBeNull();
    });

    it('rejects a wrong state and deletes the attempt', async () => {
      await authorize(app, 'gs-wrong');
      const res = await call(app, 'POST', '/callback', 'gs-wrong', { code: FAKE_CODE, state: 'not-the-state' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'google-sheet-state-invalid' });
      expect(await (await repoOf(app, 'gs-wrong')).takeOauthRequest()).toBeNull();
      expect(google.calls).toEqual([]);
    });

    it('rejects an expired state', async () => {
      const { state } = await authorize(app, 'gs-expired');
      jest.useFakeTimers({ now: Date.now() + 10 * 60_000 + 1, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
      const res = await call(app, 'POST', '/callback', 'gs-expired', { code: FAKE_CODE, state });
      expect(res.statusCode).toBe(400);
      expect(google.calls).toEqual([]);
    });

    it("rejects another user's state", async () => {
      const { state } = await authorize(app, 'gs-victim');
      await authorize(app, 'gs-attacker');
      const res = await call(app, 'POST', '/callback', 'gs-attacker', { code: FAKE_CODE, state });
      expect(res.statusCode).toBe(400);
      expect(google.calls).toEqual([]);
      expect((await call(app, 'GET', '', 'gs-victim')).json()).toMatchObject({ status: 'unlinked' });
    });

    it('stores nothing when the grant lacks drive.file', async () => {
      google.scope = 'openid';
      const res = await link(app, 'gs-scope');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'google-sheet-scope-not-granted' });
      expect(await (await repoOf(app, 'gs-scope')).getLink()).toBeNull();
      expect(google.calls.map((c) => c.method)).toEqual(['exchangeCode']);
    });

    it('re-linking replaces the token without revoking it, and keeps a sheet the app can still open', async () => {
      await link(app, 'gs-relink');
      const before = (await (await repoOf(app, 'gs-relink')).getLink())!;
      google.calls = [];
      const res = await link(app, 'gs-relink');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ spreadsheetUrl: before.spreadsheetUrl });
      expect(google.calls.map((c) => c.method)).toEqual(['exchangeCode', 'canOpenSpreadsheet']);
      const after = (await (await repoOf(app, 'gs-relink')).getLink())!;
      expect(after.token!.ciphertext.equals(before.token!.ciphertext)).toBe(false);
    });

    it('re-linking creates a new sheet when the old one is gone', async () => {
      await link(app, 'gs-relink-gone');
      google.openable.clear();
      const res = await link(app, 'gs-relink-gone');
      expect(res.json()).toMatchObject({ status: 'linked', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-2/edit' });
      expect(google.calls.some((c) => c.method === 'revoke')).toBe(false);
    });
  });

  describe('GET, unlink and a new sheet', () => {
    it('GET never returns a token or the spreadsheet ID on its own', async () => {
      await link(app, 'gs-get');
      const body = (await call(app, 'GET', '', 'gs-get')).json();
      expect(Object.keys(body).sort()).toEqual(['configured', 'lastMirroredAt', 'spreadsheetUrl', 'status']);
      expect(JSON.stringify(body)).not.toContain(FAKE_REFRESH_TOKEN);
    });

    it('unlink revokes the decrypted token and deletes the row', async () => {
      await link(app, 'gs-unlink');
      const res = await call(app, 'DELETE', '', 'gs-unlink');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revoked: true });
      expect(google.calls.find((c) => c.method === 'revoke')!.args).toEqual([FAKE_REFRESH_TOKEN]);
      expect((await call(app, 'GET', '', 'gs-unlink')).json()).toMatchObject({ status: 'unlinked' });
    });

    it('unlink deletes the row even when the revoke fails, and says so', async () => {
      await link(app, 'gs-unlink-fail');
      jest.spyOn(google, 'revoke').mockRejectedValue(new GoogleApiError(503, 'backendError'));
      const res = await call(app, 'DELETE', '', 'gs-unlink-fail');
      expect(res.json()).toEqual({ revoked: false, permissionsUrl: GOOGLE_PERMISSIONS_URL });
      expect(await (await repoOf(app, 'gs-unlink-fail')).getLink()).toBeNull();
    });

    it('creates a new sheet for a sheet_missing link with the stored token', async () => {
      await link(app, 'gs-missing');
      (await repoOf(app, 'gs-missing')).setStatusForTest('sheet_missing');
      google.calls = [];
      const res = await call(app, 'POST', '/sheet', 'gs-missing');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'linked', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-2/edit' });
      expect(google.calls.map((c) => [c.method, c.args[c.args.length - 1]])).toEqual([
        ['refreshAccessToken', FAKE_REFRESH_TOKEN],
        ['createSpreadsheet', expect.any(String)],
      ]);
    });

    it('refuses a new sheet for a link that is not missing', async () => {
      await link(app, 'gs-not-missing');
      expect((await call(app, 'POST', '/sheet', 'gs-not-missing')).statusCode).toBe(409);
    });
  });

  describe('logging (decisions 24-25)', () => {
    // A gaxios-like error, carrying its request, as a client library would throw it.
    const rawError = (secret: string) =>
      Object.assign(new Error(`request failed: ${secret}`), { config: { body: `code=${secret}`, headers: { Authorization: `Bearer ${secret}` } } });

    const logged = (spies: jest.SpyInstance[]) => JSON.stringify(spies.flatMap((s) => s.mock.calls));

    it('logs a failed exchange and a failed revoke without the token or the code', async () => {
      const spies = [jest.spyOn(Logger.prototype, 'warn'), jest.spyOn(Logger.prototype, 'error'), jest.spyOn(Logger.prototype, 'log')];
      jest.spyOn(google, 'exchangeCode').mockRejectedValueOnce(rawError(FAKE_CODE));
      const failed = await link(app, 'gs-log');
      expect(failed.statusCode).toBe(502);
      expect(failed.body).not.toContain(FAKE_CODE);

      await link(app, 'gs-log');
      jest.spyOn(google, 'revoke').mockRejectedValueOnce(rawError(FAKE_REFRESH_TOKEN));
      expect((await call(app, 'DELETE', '', 'gs-log')).json()).toMatchObject({ revoked: false });

      jest.spyOn(google, 'revoke').mockRejectedValueOnce(new GoogleApiError(400, 'invalid_token'));
      await link(app, 'gs-log');
      await call(app, 'DELETE', '', 'gs-log');

      const text = logged(spies);
      expect(spies[0]!.mock.calls.length).toBe(3);
      expect(text).toContain('"operation":"exchange"');
      expect(text).toContain('"status":400,"reason":"invalid_token"');
      for (const secret of [FAKE_CODE, FAKE_REFRESH_TOKEN, ENV.GOOGLE_OAUTH_CLIENT_SECRET, 'sheet-1']) {
        expect(text).not.toContain(secret);
      }
    });
  });

  it('makes no Google call until the lifter authorizes and completes a callback (decision 22)', async () => {
    await app.close();
    app = await boot(failingGoogleClient());
    const user = 'gs-untouched';
    expect((await call(app, 'GET', '', user)).statusCode).toBe(200);
    expect((await call(app, 'DELETE', '', user)).json()).toEqual({ revoked: true });
    expect((await call(app, 'POST', '/sheet', user)).statusCode).toBe(404);
    expect((await call(app, 'POST', '/callback', user, { code: FAKE_CODE, state: 'x' })).statusCode).toBe(400);
    expect((await call(app, 'POST', '/authorize', user)).statusCode).toBe(200);
    const supplements = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/supplements', headers: { authorization: `Bearer ${user}` } });
    expect(supplements.statusCode).toBeLessThan(500);
  });
});
