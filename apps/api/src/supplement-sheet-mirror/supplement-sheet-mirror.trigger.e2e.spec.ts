import 'reflect-metadata';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { GOOGLE_SHEET_CLIENT, GOOGLE_TOKEN_CIPHER } from '../google-sheet/google-sheet.service';
import { TokenCipher } from '../google-sheet/token-cipher';
import { FAKE_REFRESH_TOKEN, FakeGoogleSheetClient, FakeKeyWrapper } from '../google-sheet/fakes';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { CloudTasksError, ISheetMirrorQueue, MirrorTaskKind, SHEET_MIRROR_QUEUE } from './sheet-mirror-queue';

/**
 * The triggers of the supplement sheet mirror (#1444, ADR-047 decisions 16, 17, 22, 24): a
 * supplement write enqueues a run once its response is on its way, and Sync now enqueues one at
 * once. The queue and Google are fakes.
 */

const TODAY = '2026-11-23';
const SECRET = 'ya29.SECRET-TOKEN-do-not-log';
const spans = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }).register();

class FakeQueue implements ISheetMirrorQueue {
  enqueued: { userId: string; kind: MirrorTaskKind }[] = [];
  failWith?: Error;
  async enqueue(userId: string, _now?: Date, kind: MirrorTaskKind = 'change') {
    if (this.failWith) throw this.failWith;
    this.enqueued.push({ userId, kind });
  }
}

/** Fails the test if anything calls it, for the checks that nothing is sent before linking. */
class ForbiddenQueue implements ISheetMirrorQueue {
  calls = 0;
  async enqueue(): Promise<void> {
    this.calls += 1;
    throw new Error('the queue must not be called');
  }
}

describe('Supplement sheet mirror triggers (e2e, in-memory)', () => {
  let app: NestFastifyApplication;
  let google: FakeGoogleSheetClient;
  const cipher = new TokenCipher(new FakeKeyWrapper());
  let n = 0;

  async function start(queue: ISheetMirrorQueue) {
    google = new FakeGoogleSheetClient();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_SHEET_CLIENT)
      .useValue(google)
      .overrideProvider(GOOGLE_TOKEN_CIPHER)
      .useValue(cipher)
      .overrideProvider(SHEET_MIRROR_QUEUE)
      .useValue(queue)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  beforeEach(() => spans.reset());
  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const call = (user: string, method: 'POST' | 'PUT', url: string, payload?: object) =>
    app.getHttpAdapter().getInstance().inject({ method, url, headers: { authorization: `Bearer ${user}` }, ...(payload && { payload }) });
  const addItem = (user: string, name = 'Creatine') =>
    call(user, 'POST', `/supplements/items?today=${TODAY}`, { name, doses: [{ slot: 'am', amount: '1 scoop', servings: 1, dayTypes: [] }] });
  const sync = (user: string) => call(user, 'POST', '/integrations/google-sheet/sync');
  /** Lets the enqueue that follows a response finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  async function linkedUser() {
    const user = `trigger_user_${(n += 1)}`;
    const { googleSheetLink } = await app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user } as never);
    await googleSheetLink.saveLink({
      status: 'linked',
      spreadsheetId: 'sheet-1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
      grantedScope: 'drive.file',
      token: await cipher.encrypt(user, FAKE_REFRESH_TOKEN),
      lastErrorCode: null,
    });
    return user;
  }

  describe('after a supplement write', () => {
    let queue: FakeQueue;
    beforeEach(async () => {
      queue = new FakeQueue();
      await start(queue);
    });

    it('enqueues one change run for a linked user once the write has committed, carrying only the user', async () => {
      const user = await linkedUser();
      expect((await addItem(user)).statusCode).toBe(201);
      await settle();
      expect(queue.enqueued).toEqual([{ userId: user, kind: 'change' }]);
    });

    it.each([
      ['a settings write that changes nothing', () => ['PUT', `/supplements/settings?today=${TODAY}`, {}] as const],
      ['a write that is refused', () => ['POST', `/supplements/items?today=${TODAY}`, { name: '' }] as const],
    ])('enqueues nothing for %s', async (_name, request) => {
      const user = await linkedUser();
      const [method, url, payload] = request();
      expect((await call(user, method, url, payload)).statusCode).toBeLessThan(500);
      await settle();
      expect(queue.enqueued).toEqual([]);
    });

    it('returns the write’s normal response when the enqueue throws, and logs and traces the failure without secrets', async () => {
      const user = await linkedUser();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      queue.failWith = Object.assign(new CloudTasksError(503), { message: `Cloud Tasks create: 503 Bearer ${SECRET}` });

      const res = await addItem(user);
      await settle();

      expect(res.statusCode).toBe(201);
      expect(res.json().items).toHaveLength(1);
      const [payload] = warn.mock.calls.find(([p]) => (p as { operation?: string }).operation === 'sheet_mirror.enqueue') ?? [];
      expect(payload).toMatchObject({ operation: 'sheet_mirror.enqueue', outcome: 'failed', status: 503, reason: 'CloudTasksError', linkStatus: 'linked', kind: 'change' });
      const span = spans.getFinishedSpans().find((s) => s.name === 'sheet_mirror.enqueue');
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes).toMatchObject({ 'sheet_mirror.outcome': 'failed', 'sheet_mirror.google_status': 503, 'sheet_mirror.link_status': 'linked' });
      // Decision 24: nothing secret reaches a log line or a span.
      const everything = JSON.stringify([warn.mock.calls, spans.getFinishedSpans().map((s) => [s.attributes, s.events])]);
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain('sheet-1');
      expect(everything).not.toContain('docs.google.com');
    });

    it('records a successful enqueue on a span with the outcome and the link status only', async () => {
      const user = await linkedUser();
      await addItem(user);
      await settle();
      const span = spans.getFinishedSpans().find((s) => s.name === 'sheet_mirror.enqueue');
      expect(span?.attributes).toMatchObject({ 'sheet_mirror.outcome': 'enqueued', 'sheet_mirror.link_status': 'linked', 'sheet_mirror.kind': 'change' });
    });
  });

  describe('Sync now', () => {
    let queue: FakeQueue;
    beforeEach(async () => {
      queue = new FakeQueue();
      await start(queue);
    });

    it('enqueues a sync run for a linked user and answers 202', async () => {
      const user = await linkedUser();
      const res = await sync(user);
      expect(res.statusCode).toBe(202);
      expect(queue.enqueued).toEqual([{ userId: user, kind: 'sync' }]);
    });

    it('answers 502 with fixed words when the queue refuses, and can be pressed again', async () => {
      const user = await linkedUser();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      queue.failWith = new Error(`boom ${SECRET}`);

      const res = await sync(user);

      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: 'sheet-mirror-enqueue-failed' });
      expect(JSON.stringify([res.json(), warn.mock.calls])).not.toContain(SECRET);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: 'sheet_mirror.enqueue', outcome: 'failed', kind: 'sync' }), expect.any(String));

      delete queue.failWith;
      expect((await sync(user)).statusCode).toBe(202);
    });

    it('answers 409 when nothing is linked, and enqueues nothing', async () => {
      const res = await sync('trigger_unlinked');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'google-sheet-not-linked' });
      expect(queue.enqueued).toEqual([]);
    });
  });

  describe('before the lifter links a sheet (decision 22)', () => {
    it('sends nothing to Google and enqueues nothing across a supplement write and Sync now', async () => {
      const queue = new ForbiddenQueue();
      await start(queue);

      expect((await addItem('trigger_never_linked')).statusCode).toBe(201);
      expect((await sync('trigger_never_linked')).statusCode).toBe(409);
      await settle();

      expect(queue.calls).toBe(0);
      expect(google.calls).toEqual([]);
    });

    it.each(['needs_relink', 'sheet_missing'] as const)('also enqueues nothing while the link is %s', async (status) => {
      const queue = new ForbiddenQueue();
      await start(queue);
      const user = `trigger_${status}`;
      const { googleSheetLink } = await app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user } as never);
      await googleSheetLink.saveLink({
        status,
        spreadsheetId: 'sheet-1',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        grantedScope: 'drive.file',
        token: status === 'sheet_missing' ? await cipher.encrypt(user, FAKE_REFRESH_TOKEN) : null,
        lastErrorCode: status,
      });

      await addItem(user);
      expect((await sync(user)).statusCode).toBe(409);
      await settle();

      expect(queue.calls).toBe(0);
      expect(google.calls).toEqual([]);
    });
  });

  describe('the link view', () => {
    it('reports syncFailed only for a linked sheet whose last error stays on the row', async () => {
      await start(new FakeQueue());
      const user = await linkedUser();
      const read = async () =>
        (await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/integrations/google-sheet', headers: { authorization: `Bearer ${user}` } })).json();
      expect((await read()).syncFailed).toBe(false);

      const repo = (await app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user } as never)).googleSheetLink;
      const lease = await repo.takeMirrorLease('sheet-1');
      await repo.releaseMirrorLease(lease!, 'google_503');
      expect((await read()).syncFailed).toBe(true);
    });
  });
});
