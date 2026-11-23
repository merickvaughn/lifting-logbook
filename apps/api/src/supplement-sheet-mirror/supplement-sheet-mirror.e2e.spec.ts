import 'reflect-metadata';
import { generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SupplementChange } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { InMemoryGoogleSheetLinkRepository } from '../adapters/in-memory/google-sheet-link.adapter';
import { InMemorySupplementRepository } from '../adapters/in-memory/supplement.adapter';
import { GoogleApiError } from '../google-sheet/google-sheet.client';
import { GOOGLE_SHEET_CLIENT, GOOGLE_TOKEN_CIPHER } from '../google-sheet/google-sheet.service';
import { TokenCipher } from '../google-sheet/token-cipher';
import { FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, FakeGoogleSheetClient, FakeKeyWrapper } from '../google-sheet/fakes';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { GoogleOidcVerifier } from './oidc-verifier';
import { ISheetMirrorQueue, SHEET_MIRROR_QUEUE, taskName } from './sheet-mirror-queue';
import { OIDC_VERIFIER } from './supplement-sheet-mirror.controller';

/**
 * In-memory E2E for the supplement sheet mirror run (#1443, ADR-047 decisions 15-25). Google is a
 * fake client, KMS a fake key wrapper and Cloud Tasks a fake queue. The OIDC check is the real
 * one, against a key pair made here.
 */

const API_URL = 'https://api.example.run.app';
const SA_EMAIL = 'sheet-mirror-tasks@project.iam.gserviceaccount.com';
const ENV = { SHEET_MIRROR_API_URL: API_URL, SHEET_MIRROR_TASKS_SA_EMAIL: SA_EMAIL };
const SECRET_NOTE = 'SECRET-CELL-VALUE-do-not-log';
const TODAY = '2026-11-23';
const saved: Record<string, string | undefined> = {};

const spans = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }).register();

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1' };

function token(claims: Record<string, unknown> = {}, signer: KeyObject = keys.privateKey): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64({
    iss: 'https://accounts.google.com',
    aud: API_URL,
    email: SA_EMAIL,
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), signer).toString('base64url')}`;
}

class FakeQueue implements ISheetMirrorQueue {
  enqueued: string[] = [];
  /** Set to make every enqueue throw it. */
  failWith?: Error;
  async enqueue(userId: string) {
    if (this.failWith) throw this.failWith;
    this.enqueued.push(userId);
  }
}

describe('Supplement sheet mirror (e2e, in-memory)', () => {
  let app: NestFastifyApplication;
  let google: FakeGoogleSheetClient;
  let queue: FakeQueue;
  const cipher = new TokenCipher(new FakeKeyWrapper());
  let n = 0;

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
    queue = new FakeQueue();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_SHEET_CLIENT)
      .useValue(google)
      .overrideProvider(GOOGLE_TOKEN_CIPHER)
      .useValue(cipher)
      .overrideProvider(OIDC_VERIFIER)
      .useValue(new GoogleOidcVerifier(async () => [publicJwk]))
      .overrideProvider(SHEET_MIRROR_QUEUE)
      .useValue(queue)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const repos = (user: string) => app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user } as never);

  /** A user with a linked sheet and a stack of one item whose note starts with `=`. */
  async function linkedUser(note = SECRET_NOTE, tokenOwner?: string) {
    const user = `user_${(n += 1)}`;
    const { googleSheetLink } = await repos(user);
    await googleSheetLink.saveLink({
      status: 'linked',
      spreadsheetId: 'sheet-1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
      grantedScope: 'drive.file',
      token: await cipher.encrypt(tokenOwner ?? user, FAKE_REFRESH_TOKEN),
      lastErrorCode: null,
    });
    await addItem(user, 'Creatine', note);
    // The write above enqueued its own run (#1444); these tests start from an empty queue.
    await settle();
    queue.enqueued = [];
    return user;
  }

  /** Lets the post-response enqueue of a supplement write finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  const addItem = (user: string, name: string, shortNote: string) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/supplements/items?today=${TODAY}`,
      headers: { authorization: `Bearer ${user}` },
      payload: { name, shortNote, doses: [{ slot: 'am', amount: '1 scoop', servings: 2, dayTypes: [] }] },
    });

  const run = (user: string, headers: Record<string, string> = { authorization: `Bearer ${token()}` }) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/supplement-sheet-mirror',
      headers,
      payload: { userId: user },
    });

  const link = async (user: string) => (await repos(user)).googleSheetLink.getLink();
  const cellsOf = (batch: Record<string, unknown>[]) =>
    batch
      .filter((r) => 'updateCells' in r)
      .map((r) => (r.updateCells as { rows: { values: { userEnteredValue: Record<string, unknown> }[] }[] }).rows.map((row) => row.values.map((c) => c.userEnteredValue)));

  describe('who may call it', () => {
    it('accepts a Google-signed token for the API URL from the verified service account', async () => {
      const res = await run(await linkedUser());
      expect(res.statusCode).toBe(204);
    });

    it.each([
      ['a wrong audience', { aud: 'https://other.example' }],
      ['a wrong email', { email: 'someone@project.iam.gserviceaccount.com' }],
      ['an unverified email', { email_verified: false }],
      ['an expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
      ['another issuer', { iss: 'https://evil.example' }],
    ])('rejects %s with 401 and calls nothing', async (_name, claims) => {
      const res = await run(await linkedUser(), { authorization: `Bearer ${token(claims)}` });
      expect(res.statusCode).toBe(401);
      expect(google.calls).toEqual([]);
    });

    it('rejects no token, a token signed by another key, and a malformed one with 401', async () => {
      const user = await linkedUser();
      expect((await run(user, {})).statusCode).toBe(401);
      expect((await run(user, { authorization: `Bearer ${token({}, otherKeys.privateKey)}` })).statusCode).toBe(401);
      expect((await run(user, { authorization: 'Bearer not.a.jwt' })).statusCode).toBe(401);
      expect((await run(user, { authorization: 'Bearer x' })).statusCode).toBe(401);
      expect(google.calls).toEqual([]);
    });

    it('rejects everything while the audience or account is not configured', async () => {
      delete process.env.SHEET_MIRROR_API_URL;
      try {
        expect((await run(await linkedUser())).statusCode).toBe(401);
      } finally {
        process.env.SHEET_MIRROR_API_URL = API_URL;
      }
    });

    it('answers 5xx when Google signing keys cannot be fetched, so Cloud Tasks retries', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(OIDC_VERIFIER)
        .useValue(new GoogleOidcVerifier(async () => Promise.reject(new Error('down'))))
        .compile();
      const broken = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
      await broken.init();
      await broken.getHttpAdapter().getInstance().ready();
      const res = await broken.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/internal/supplement-sheet-mirror',
        headers: { authorization: `Bearer ${token()}` },
        payload: { userId: 'u' },
      });
      await broken.close();
      expect(res.statusCode).toBe(503);
    });

    it('a Clerk token for the user does not open the route', async () => {
      const user = await linkedUser();
      const res = await run(user, { authorization: `Bearer ${user}` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('a run', () => {
    it('writes both tabs in one batchUpdate and records what it mirrored', async () => {
      google.tabs = [{ sheetId: 0, title: 'Supplements' }];
      const user = await linkedUser('=HYPERLINK("https://evil.example")');
      await addItem(user, 'Magnesium', '');
      await settle();
      queue.enqueued = [];

      expect((await run(user)).statusCode).toBe(204);

      expect(google.batches).toHaveLength(1);
      const batch = google.batches[0]!;
      // History is missing, so it's added in the same batch; Supplements exists and isn't.
      expect(batch.filter((r) => 'addSheet' in r)).toEqual([
        { addSheet: { properties: { sheetId: 1, title: 'History', gridProperties: { rowCount: 3, columnCount: 4 } } } },
      ]);
      expect(batch.filter((r) => 'updateCells' in r).map((r) => (r.updateCells as { range: unknown }).range)).toEqual([
        { sheetId: 0 },
        { sheetId: 1 },
      ]);
      const [supplements, history] = cellsOf(batch) as [Record<string, unknown>[][], Record<string, unknown>[][]];
      expect(supplements[0]).toEqual(
        ['Name', 'Slot', 'Amount', 'Servings', 'Day types', 'Timing', 'Notes', 'Links', 'Status'].map((stringValue) => ({ stringValue })),
      );
      expect(supplements[1]).toEqual([
        { stringValue: 'Creatine' },
        { stringValue: 'am' },
        { stringValue: '1 scoop' },
        { numberValue: 2 },
        { stringValue: '' },
        { stringValue: '' },
        { stringValue: '=HYPERLINK("https://evil.example")' },
        { stringValue: '' },
        { stringValue: 'active' },
      ]);
      expect(supplements).toHaveLength(3);
      // Newest first: Magnesium was added after Creatine.
      expect(history.slice(1).map((row) => row[2])).toEqual([{ stringValue: 'Magnesium' }, { stringValue: 'Creatine' }]);
      // Text only, never a formula, and nothing the app uses to identify a row or a user.
      const sent = JSON.stringify(batch);
      expect(sent).not.toContain('formulaValue');
      expect(sent).not.toContain(user);
      expect(sent).not.toMatch(/"(itemId|id|seq)"/);

      const stored = await link(user);
      expect(stored?.lastMirroredAt).toBeInstanceOf(Date);
      // Two items added: the highest seq written is 2.
      expect(stored?.lastMirroredSeq).toBe(2);
      expect(stored?.lastErrorCode).toBeNull();
      expect(queue.enqueued).toEqual([]);
      // The lease is released, so the next run isn't a 409.
      expect((await run(user)).statusCode).toBe(204);
    });

    it('adds a missing Supplements tab too, with ids that do not clash', async () => {
      google.tabs = [{ sheetId: 7, title: 'Notes' }];
      expect((await run(await linkedUser())).statusCode).toBe(204);
      expect(google.batches[0]!.filter((r) => 'addSheet' in r)).toEqual([
        { addSheet: { properties: { sheetId: 8, title: 'Supplements', gridProperties: { rowCount: 2, columnCount: 9 } } } },
        { addSheet: { properties: { sheetId: 9, title: 'History', gridProperties: { rowCount: 2, columnCount: 4 } } } },
      ]);
    });

    it.each([
      ['an existing History tab', [{ sheetId: 0, title: 'Supplements' }, { sheetId: 1, title: 'History' }]],
      ['a missing History tab', [{ sheetId: 0, title: 'Supplements' }]],
    ])("writes a History longer than a new tab's 1000 rows to %s", async (_name, tabs) => {
      google.tabs = tabs;
      const user = await linkedUser();
      const many: SupplementChange[] = Array.from({ length: 1200 }, (_, i) => ({ type: 'confirmed', itemId: 'x', seq: i + 1, date: TODAY }));
      jest.spyOn(InMemorySupplementRepository.prototype, 'allChanges').mockResolvedValue(many);

      expect((await run(user)).statusCode).toBe(204);
      expect(google.batches).toHaveLength(1);
      expect(google.gridOf('History')).toEqual({ rowCount: 1201, columnCount: 4 });
      expect(await link(user)).toMatchObject({ status: 'linked', lastErrorCode: null });
    });

    it("shrinks a tab's grid to the rows written, so no blank rows trail them", async () => {
      google.tabs = [{ sheetId: 0, title: 'Supplements' }, { sheetId: 1, title: 'History' }];
      google.grids.set(0, { rowCount: 50, columnCount: 30 });
      expect((await run(await linkedUser())).statusCode).toBe(204);
      expect(google.gridOf('Supplements')).toEqual({ rowCount: 2, columnCount: 9 });
      expect(google.gridOf('History')).toEqual({ rowCount: 2, columnCount: 4 });
    });

    it('answers 409 while another run holds the lease, and calls Google not at all', async () => {
      const user = await linkedUser();
      expect(await (await repos(user)).googleSheetLink.takeMirrorLease('sheet-1')).not.toBeNull();
      expect((await run(user)).statusCode).toBe(409);
      expect(google.calls).toEqual([]);
    });

    it('enqueues one more run when the stack changed while it wrote', async () => {
      const user = await linkedUser();
      google.beforeBatch = async () => {
        google.beforeBatch = undefined;
        await addItem(user, 'Zinc', '');
      };
      expect((await run(user)).statusCode).toBe(204);
      // Zinc's own write enqueued a run, and the follow-up is the second.
      await settle();
      expect(queue.enqueued).toEqual([user, user]);
    });

    it('still answers 204 and records the run when the follow-up cannot be enqueued, and logs why', async () => {
      const user = await linkedUser();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      queue.failWith = new Error('Cloud Tasks create: 503');
      google.beforeBatch = async () => {
        google.beforeBatch = undefined;
        await addItem(user, 'Zinc', '');
      };

      expect((await run(user)).statusCode).toBe(204);

      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: 'sheet_mirror.follow_up', reason: 'Error' }), expect.any(String));
      expect(await link(user)).toMatchObject({ lastMirroredSeq: 1, lastErrorCode: null });
      expect(queue.enqueued).toEqual([]);
    });

    it('sends no item or day-type ID from the stack to Google, anywhere in the request', async () => {
      const user = await linkedUser();
      const dayType = { id: 'dt-0c9f2b7e-training', name: 'Training day' };
      const put = await app.getHttpAdapter().getInstance().inject({
        method: 'PUT',
        url: `/supplements/settings?today=${TODAY}`,
        headers: { authorization: `Bearer ${user}` },
        payload: { dayTypes: [dayType] },
      });
      expect(put.statusCode).toBe(200);
      const added = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/supplements/items?today=${TODAY}`,
        headers: { authorization: `Bearer ${user}` },
        payload: { name: 'Magnesium', doses: [{ slot: 'am', amount: '200 mg', servings: 1, dayTypes: [dayType.id] }] },
      });
      expect(added.statusCode).toBe(201);
      const state = await (await repos(user)).supplement.load();
      const ids = [...state.items.map((i) => i.id), ...state.dayTypes.map((d) => d.id)];
      expect(ids).toContain(dayType.id);
      expect(state.items.flatMap((i) => i.doses.flatMap((d) => d.dayTypes))).toContain(dayType.id);

      expect((await run(user)).statusCode).toBe(204);

      const sent = JSON.stringify(google.batches);
      // The day type is sent by its name, so the dose's day types did reach the request.
      expect(sent).toContain(dayType.name);
      for (const id of ids) expect(sent).not.toContain(id);
    });

    it('names a window task by a hash of the user, never the user', () => {
      const name = taskName('user_abc', 57);
      expect(name).toMatch(/^[0-9a-f]{32}-57$/);
      expect(name).not.toContain('abc');
    });

    it('returns 204 with no row, and for a link that needs a new token or a new sheet', async () => {
      expect((await run('user_nobody')).statusCode).toBe(204);
      for (const status of ['needs_relink', 'sheet_missing'] as const) {
        const user = await linkedUser();
        const { googleSheetLink } = await repos(user);
        const stored = (await googleSheetLink.getLink())!;
        await googleSheetLink.saveLink(status === 'needs_relink' ? { ...stored, status, token: null } : { ...stored, status });
        expect((await run(user)).statusCode).toBe(204);
      }
      expect(google.calls).toEqual([]);
    });
  });

  describe('outcomes Cloud Tasks acts on', () => {
    it.each([
      ['a 429', new GoogleApiError(429, 'RESOURCE_EXHAUSTED', { googleStatus: 'RESOURCE_EXHAUSTED' })],
      ['a 500', new GoogleApiError(500, 'INTERNAL', { googleStatus: 'INTERNAL' })],
      ['a 503', new GoogleApiError(503, 'UNAVAILABLE', { googleStatus: 'UNAVAILABLE' })],
      ['a quota 403', new GoogleApiError(403, 'rateLimitExceeded', { legacy: ['rateLimitExceeded'] })],
      ['a 408', new GoogleApiError(408, 'REQUEST_TIMEOUT')],
      ['a timeout', new GoogleApiError(0, 'timeout')],
    ])('answers 5xx for %s, keeps the sheet linked, and succeeds on the retry', async (_name, err) => {
      const user = await linkedUser();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      google.failNextBatch = err;

      expect((await run(user)).statusCode).toBe(503);
      expect(warn).toHaveBeenCalled();
      expect((await link(user))?.status).toBe('linked');
      // Retries remain, so Settings doesn't show "Last sync failed" yet (decision 21).
      expect((await link(user))?.lastErrorCode).toBeNull();

      // The lease was released, so the retry gets in, writes, and clears the error.
      expect((await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '1' })).statusCode).toBe(204);
      expect(google.batches).toHaveLength(1);
      expect((await link(user))?.lastErrorCode).toBeNull();
    });

    it('answers 503 and logs at warn when the database fails mid-run, and calls Google not at all', async () => {
      const user = await linkedUser();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(InMemorySupplementRepository.prototype, 'allChanges').mockRejectedValue(new Error('connection terminated'));

      expect((await run(user)).statusCode).toBe(503);

      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: 'sheet_mirror.run', outcome: 'retry_internal' }), expect.any(String));
      expect(google.calls).toEqual([]);
      expect(await link(user)).toMatchObject({ status: 'linked', lastErrorCode: null });
    });

    it('ends the task on the last attempt: stores the code, logs once at error and answers 204, and a later success clears it', async () => {
      const user = await linkedUser();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      google.failNextBatch = new GoogleApiError(503, 'UNAVAILABLE', { googleStatus: 'UNAVAILABLE' });

      // 204, not 5xx: Cloud Tasks would otherwise retry until max-retry-duration too (decision 21).
      expect((await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '7' })).statusCode).toBe(204);

      expect(await link(user)).toMatchObject({ status: 'linked', lastErrorCode: 'google_503' });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'retry_google', attempt: 7 }), expect.any(String));
      // The lease was released: Sync now's run gets in, writes, and clears the code.
      expect((await run(user)).statusCode).toBe(204);
      expect(google.batches).toHaveLength(1);
      expect((await link(user))?.lastErrorCode).toBeNull();
    });

    it('answers 503 on an earlier attempt, and stores no code', async () => {
      const user = await linkedUser();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      google.failNextBatch = new GoogleApiError(503, 'UNAVAILABLE', { googleStatus: 'UNAVAILABLE' });

      expect((await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '6' })).statusCode).toBe(503);

      expect(await link(user)).toMatchObject({ status: 'linked', lastErrorCode: null });
    });

    it('answers 503 on the last attempt when the code could not be stored, so Cloud Tasks keeps retrying', async () => {
      const user = await linkedUser();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      google.failNextBatch = new GoogleApiError(503, 'UNAVAILABLE', { googleStatus: 'UNAVAILABLE' });
      jest.spyOn(InMemoryGoogleSheetLinkRepository.prototype, 'releaseMirrorLease').mockRejectedValueOnce(new Error('connection terminated'));

      expect((await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '7' })).statusCode).toBe(503);
      expect((await link(user))?.lastErrorCode).toBeNull();
    });

    it('answers 503 on the last attempt when the database fails before the lease', async () => {
      const user = await linkedUser();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      jest.spyOn(InMemoryGoogleSheetLinkRepository.prototype, 'getLink').mockRejectedValueOnce(new Error('connection terminated'));

      expect((await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '7' })).statusCode).toBe(503);
      expect(google.calls).toEqual([]);
    });

    it('answers 5xx for a KMS or database failure, not 204', async () => {
      // A token encrypted for another user fails to decrypt, as a KMS failure would.
      const user = await linkedUser(SECRET_NOTE, 'someone_else');
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      expect((await run(user)).statusCode).toBe(503);
      expect(google.calls).toEqual([]);
      expect((await link(user))?.status).toBe('linked');
    });

    it.each([
      ['a 400', new GoogleApiError(400, 'INVALID_ARGUMENT', { googleStatus: 'INVALID_ARGUMENT' })],
      ['a 413', new GoogleApiError(413, 'unknown')],
    ])('records %s as the last error, logs it at error and answers 204, since a retry would send it again', async (_name, err) => {
      const user = await linkedUser();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      google.failNextBatch = err;

      expect((await run(user)).statusCode).toBe(204);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'google_rejected', googleStatus: err.status }), expect.any(String));
      expect(warn).not.toHaveBeenCalled();
      expect(await link(user)).toMatchObject({ status: 'linked', lastErrorCode: `google_${err.status}` });
      // The lease was released: the next run writes.
      expect((await run(user)).statusCode).toBe(204);
      expect(google.batches).toHaveLength(1);
    });

    it('logs a held lease at info, even on the last attempt, and never as a failure', async () => {
      const user = await linkedUser();
      const spies = (['log', 'warn', 'error'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation());
      expect(await (await repos(user)).googleSheetLink.takeMirrorLease('sheet-1')).not.toBeNull();

      const res = await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '7' });

      expect(res.statusCode).toBe(409);
      const [log, warn, error] = spies as [jest.SpyInstance, jest.SpyInstance, jest.SpyInstance];
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'lease_held', attempt: 7 }), expect.any(String));
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('clears the token, sets needs_relink and answers 204 on invalid_grant', async () => {
      const user = await linkedUser();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      google.failNextRefresh = new GoogleApiError(400, 'invalid_grant');
      expect((await run(user)).statusCode).toBe(204);
      expect(await link(user)).toMatchObject({ status: 'needs_relink', token: null, lastErrorCode: 'invalid_grant' });
      expect(google.batches).toEqual([]);
    });

    it.each([
      ['NOT_FOUND', new GoogleApiError(404, 'NOT_FOUND', { googleStatus: 'NOT_FOUND' })],
      ['PERMISSION_DENIED on the spreadsheet', new GoogleApiError(403, 'PERMISSION_DENIED', { googleStatus: 'PERMISSION_DENIED' })],
    ])('sets sheet_missing and answers 204 on %s', async (_name, err) => {
      const user = await linkedUser();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      google.failNextBatch = err;
      expect((await run(user)).statusCode).toBe(204);
      expect(await link(user)).toMatchObject({ status: 'sheet_missing', lastErrorCode: 'sheet_missing' });
      expect((await link(user))?.token).not.toBeNull();
    });
  });

  describe('a run writes only to the link it started with', () => {
    const unlink = (user: string) => async () => (await repos(user)).googleSheetLink.deleteLink();
    const relink = (user: string) => async () =>
      (await repos(user)).googleSheetLink.saveLink({
        status: 'linked',
        spreadsheetId: 'sheet-2',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-2/edit',
        grantedScope: 'drive.file',
        token: await cipher.encrypt(user, FAKE_REFRESH_TOKEN),
        lastErrorCode: null,
      });
    type Failure = 'invalid_grant' | 'sheet_missing' | 'retry' | 'none';
    const fail = (failure: Failure) => {
      if (failure === 'invalid_grant') google.failNextRefresh = new GoogleApiError(400, 'invalid_grant');
      if (failure === 'sheet_missing') google.failNextBatch = new GoogleApiError(404, 'NOT_FOUND', { googleStatus: 'NOT_FOUND' });
      if (failure === 'retry') google.failNextBatch = new GoogleApiError(503, 'UNAVAILABLE', { googleStatus: 'UNAVAILABLE' });
    };
    const during = (failure: Failure, change: () => Promise<void>) => {
      const once = async () => {
        google.beforeRefresh = undefined;
        google.beforeBatch = undefined;
        await change();
      };
      if (failure === 'invalid_grant') google.beforeRefresh = once;
      else google.beforeBatch = once;
    };

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    it.each(['invalid_grant', 'sheet_missing', 'retry', 'none'] as const)('leaves a link deleted during the run deleted (%s)', async (failure) => {
      const user = await linkedUser();
      fail(failure);
      during(failure, unlink(user));
      await run(user);
      expect(await link(user)).toBeNull();
    });

    it.each(['invalid_grant', 'sheet_missing', 'retry', 'none'] as const)('leaves a link to another sheet made during the run as it is (%s)', async (failure) => {
      const user = await linkedUser();
      fail(failure);
      during(failure, relink(user));
      await run(user);
      expect(await link(user)).toMatchObject({ status: 'linked', spreadsheetId: 'sheet-2', lastErrorCode: null, lastMirroredAt: null, lastMirroredSeq: null });
      expect((await link(user))?.token).not.toBeNull();
      // The new link's lease is free.
      expect(await (await repos(user)).googleSheetLink.takeMirrorLease('sheet-2')).not.toBeNull();
    });

    it('keeps a new token for the same sheet when Google refused the old one', async () => {
      const user = await linkedUser();
      fail('invalid_grant');
      during('invalid_grant', async () => {
        const { googleSheetLink } = await repos(user);
        const stored = await googleSheetLink.getLink();
        if (!stored) throw new Error('no link');
        await googleSheetLink.saveLink({ ...stored, token: await cipher.encrypt(user, `${FAKE_REFRESH_TOKEN}-2`) });
      });
      expect((await run(user)).statusCode).toBe(204);
      expect(await link(user)).toMatchObject({ status: 'linked', lastErrorCode: null });
      expect((await link(user))?.token).not.toBeNull();
    });
  });

  describe('what a failed run logs', () => {
    it('carries outcome and counts, never a token, the spreadsheet ID or a cell value', async () => {
      const user = await linkedUser();
      const lines: unknown[] = [];
      jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => void lines.push(args));
      jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => void lines.push(args));
      // An error that carries everything a library error would: the token, the sheet and the cell.
      google.failNextBatch = Object.assign(new Error(`${FAKE_ACCESS_TOKEN} ${FAKE_REFRESH_TOKEN} sheet-1 ${SECRET_NOTE}`), {
        config: { headers: { authorization: `Bearer ${FAKE_ACCESS_TOKEN}` }, url: 'https://sheets.googleapis.com/v4/spreadsheets/sheet-1' },
      });

      expect((await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '3' })).statusCode).toBe(503);

      const logged = JSON.stringify(lines);
      expect(logged).toContain('sheet_mirror.run');
      expect(JSON.parse(JSON.stringify(lines))[0][0]).toMatchObject({
        outcome: 'retry_internal',
        attempt: 3,
        linkStatus: 'linked',
        supplementRows: 1,
        historyRows: 1,
        seq: 1,
      });
      for (const secret of [FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, 'sheet-1', SECRET_NOTE, 'sheets.googleapis.com']) {
        expect(logged).not.toContain(secret);
      }
    });

    it('records outcome and counts on the sheet_mirror.run span, and no token, sheet ID or cell value', async () => {
      const user = await linkedUser();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      spans.reset();
      expect((await run(user)).statusCode).toBe(204);
      google.failNextBatch = Object.assign(new Error(`${FAKE_ACCESS_TOKEN} ${FAKE_REFRESH_TOKEN} sheet-1 ${SECRET_NOTE}`), {
        config: { headers: { authorization: `Bearer ${FAKE_ACCESS_TOKEN}` }, url: 'https://sheets.googleapis.com/v4/spreadsheets/sheet-1' },
      });
      expect((await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '2' })).statusCode).toBe(503);

      const runs = spans.getFinishedSpans().filter((s) => s.name === 'sheet_mirror.run');
      const counts = { 'sheet_mirror.link_status': 'linked', 'sheet_mirror.rows.supplements': 1, 'sheet_mirror.rows.history': 1, 'sheet_mirror.seq': 1 };
      expect(runs.map((s) => s.attributes)).toEqual([
        { 'sheet_mirror.outcome': 'success', 'sheet_mirror.attempt': 0, ...counts },
        { 'sheet_mirror.outcome': 'retry_internal', 'sheet_mirror.attempt': 2, ...counts },
      ]);
      expect(runs.map((s) => s.status.code)).toEqual([SpanStatusCode.UNSET, SpanStatusCode.ERROR]);
      const recorded = JSON.stringify(
        spans.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status })),
      );
      for (const secret of [FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, 'sheet-1', SECRET_NOTE, 'Creatine', 'sheets.googleapis.com', user]) {
        expect(recorded).not.toContain(secret);
      }
    });

    it('logs a Google failure as its status and reason only, at error on the last attempt', async () => {
      const user = await linkedUser();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      google.failNextBatch = new GoogleApiError(503, 'UNAVAILABLE', { googleStatus: 'UNAVAILABLE' });
      expect((await run(user, { authorization: `Bearer ${token()}`, 'x-cloudtasks-taskretrycount': '7' })).statusCode).toBe(204);
      expect(error.mock.calls[0]![0]).toMatchObject({ outcome: 'retry_google', attempt: 7, googleStatus: 503, googleReason: 'UNAVAILABLE' });
    });
  });
});
