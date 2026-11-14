import 'reflect-metadata';
import http from 'node:http';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import type {
  ImportAssignResponse,
  ImportBreakdown,
  ImportCommitResponse,
  ImportSuggestionsResponse,
} from '@lifting-logbook/types';
import { IMPORT_SUGGESTION_HOURLY_LIMIT } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { AnthropicImportSuggestionsAdapter } from '../adapters/llm/anthropic-import-suggestions.adapter';
import { OpenAICompatibleImportSuggestionsAdapter } from '../adapters/llm/openai-compatible-import-suggestions.adapter';
import type { ImportSuggestionCall } from '../ports/IImportSuggestionProvider';
import type { SuggestionPayload } from './suggestion-payload';

/**
 * In-memory E2E for the Assign step's optional LLM suggestions (#1174). The provider's network
 * call is replaced by a spy on the adapter, so nothing leaves the process.
 */

const ENV = [
  'IMPORT_ASSIGN_ENABLED',
  'IMPORT_SUGGESTIONS_PROVIDER',
  'IMPORT_SUGGESTIONS_MODEL',
  'IMPORT_SUGGESTIONS_BASE_URL',
  'IMPORT_SUGGESTIONS_API_KEY',
] as const;

const DAY_MS = 86_400_000;
const TODAY = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS);
const START = TODAY.getTime() - 120 * DAY_MS;
const ymd = (date: Date) => date.toISOString().slice(0, 10);
const day = (n: number) => ymd(new Date(START + n * DAY_MS));
const today = ymd(TODAY);

interface Session {
  day: number;
  lifts: string[];
  sets?: number;
  notes?: string;
}

/** `count` 5/3/1 sessions every other day from `start`. */
const fiveThreeOne = (start: number, count: number, extra: Partial<Session> = {}): Session[] =>
  Array.from({ length: count }, (_, i) => ({
    day: start + i * 2,
    lifts: i % 2 === 0 ? ['Squat', 'Bench Press'] : ['Deadlift', 'Overhead Press'],
    ...extra,
  }));

/** A lift-records CSV with no program or number columns: one row per set. */
const csvOf = (sessions: Session[]) =>
  [
    'Date,Lift,Set #,Weight,Reps,Notes',
    ...sessions.flatMap((s) =>
      s.lifts.flatMap((lift) =>
        Array.from({ length: s.sets ?? 3 }, (_, i) => [day(s.day), lift, i + 1, 100 + i * 5, 5, s.notes ?? ''].join(',')),
      ),
    ),
  ].join('\n');

async function startApp(env: Partial<Record<(typeof ENV)[number], string>>) {
  for (const key of ENV) delete process.env[key];
  Object.assign(process.env, env);
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.useGlobalFilters(new DomainNotFoundFilter());
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const BOUNDARY = '----SuggestBoundary';

/** An upload of `csv` with form `fields`, and the headers to send it as `user`. */
function uploadOf(user: string, csv: string, fields: Record<string, string> = {}) {
  const parts = [
    ...Object.entries(fields).flatMap(([name, value]) => [`--${BOUNDARY}`, `Content-Disposition: form-data; name="${name}"`, '', value]),
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="file"; filename="upload.csv"',
    'Content-Type: text/csv',
    '',
    csv,
    `--${BOUNDARY}--`,
  ];
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, authorization: `Bearer ${user}` },
    payload: parts.join('\r\n'),
  };
}

function client(app: NestFastifyApplication, user: string) {
  const post = (url: string, csv: string, fields: Record<string, string> = {}) =>
    app.getHttpAdapter().getInstance().inject({ method: 'POST', url, ...uploadOf(user, csv, fields) });
  return {
    preview: (csv: string) => post('/programs/5-3-1/import?destination=lift-records', csv),
    assign: (csv: string) => post('/programs/5-3-1/import?mode=assign&destination=lift-records', csv, { today }),
    commit: (csv: string, breakdown: ImportBreakdown) =>
      post('/programs/5-3-1/import?mode=commit&destination=lift-records', csv, { today, breakdown: JSON.stringify(breakdown) }),
    suggest: (csv: string, fields: Record<string, string> = {}) =>
      post('/programs/5-3-1/import/suggestions?destination=lift-records', csv, { today, ...fields }),
  };
}

const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
afterAll(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

let nextUser = 0;
const newUser = () => `import-suggestions-e2e-${++nextUser}`;

describe('Import suggestions (#1174, e2e, in-memory adapters)', () => {
  describe('with IMPORT_SUGGESTIONS_PROVIDER unset', () => {
    let app: NestFastifyApplication;
    beforeAll(async () => {
      app = await startApp({ IMPORT_ASSIGN_ENABLED: 'true' });
    });
    afterAll(() => app.close());

    it('previews, assigns and commits with no provider called, and the suggestions route is off', async () => {
      const anthropic = jest.spyOn(AnthropicImportSuggestionsAdapter.prototype, 'suggest');
      const openai = jest.spyOn(OpenAICompatibleImportSuggestionsAdapter.prototype, 'suggest');
      // Both SDKs send through fetch: nothing at all leaves the process.
      const outbound = jest.spyOn(globalThis, 'fetch');
      try {
        const api = client(app, newUser());
        const sessions = fiveThreeOne(0, 6);
        const csv = csvOf(sessions);

        expect((await api.preview(csv)).statusCode).toBe(200);
        const assigned = await api.assign(csv);
        expect(assigned.statusCode).toBe(200);
        const body = assigned.json<ImportAssignResponse>();
        expect(body.suggestions).toBeNull();

        const suggested = await api.suggest(csv);
        expect(suggested.statusCode).toBe(200);
        expect(suggested.json<ImportSuggestionsResponse>()).toEqual({ status: 'off' });

        const [stretch] = body.stretches;
        const committed = await api.commit(csv, {
          stretches: [
            { program: '5-3-1', dates: sessions.map((s) => day(s.day)), status: stretch?.status ?? 'in-progress', statusChosen: false },
          ],
          excludedDates: [],
          nonCycleDates: [],
        });
        expect(committed.statusCode).toBe(200);
        expect(committed.json<ImportCommitResponse>()).toMatchObject({ created: 36 });

        expect(anthropic).not.toHaveBeenCalled();
        expect(openai).not.toHaveBeenCalled();
        expect(outbound).not.toHaveBeenCalled();
      } finally {
        anthropic.mockRestore();
        openai.mockRestore();
        outbound.mockRestore();
      }
    });
  });

  describe('with a provider set', () => {
    let app: NestFastifyApplication;
    let calls: ImportSuggestionCall[];
    let answer: unknown;
    beforeAll(async () => {
      app = await startApp({
        IMPORT_ASSIGN_ENABLED: 'true',
        IMPORT_SUGGESTIONS_PROVIDER: 'openai-compatible',
        IMPORT_SUGGESTIONS_MODEL: 'test-model',
        // Never dialled: the adapter's call is replaced below.
        IMPORT_SUGGESTIONS_BASE_URL: 'http://127.0.0.1:9/v1',
      });
    });
    afterAll(() => app.close());

    let spy: jest.SpyInstance;
    beforeEach(() => {
      calls = [];
      answer = { suggestions: [] };
      spy = jest.spyOn(OpenAICompatibleImportSuggestionsAdapter.prototype, 'suggest').mockImplementation(async (call) => {
        calls.push(call);
        return { output: answer, inputTokens: 10, outputTokens: 2, truncated: false };
      });
    });
    afterEach(() => spy.mockRestore());

    const payloadOf = (i = 0) => calls[i]?.payload as SuggestionPayload;

    // inject() never closes a socket, so this one listens on a real port and hangs up mid-call.
    it('aborts the provider call when the client disconnects', async () => {
      let reached: () => void = () => undefined;
      const atProvider = new Promise<void>((resolve) => (reached = resolve));
      let providerSignal: AbortSignal | undefined;
      spy.mockImplementationOnce(
        (_call, signal) =>
          new Promise((_resolve, reject) => {
            providerSignal = signal;
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })));
            reached();
          }),
      );
      await app.listen(0, '127.0.0.1');
      const { hostname, port } = new URL(await app.getUrl());
      const { headers, payload } = uploadOf(newUser(), csvOf(fiveThreeOne(0, 6)));
      const req = http.request({ host: hostname, port, method: 'POST', path: '/programs/5-3-1/import/suggestions', headers });
      req.on('error', () => undefined); // the hang-up below
      // A response before the provider is reached (a 4xx, say) fails here with its status, rather
      // than leaving the test to time out.
      const answeredFirst = new Promise<never>((_resolve, reject) =>
        req.on('response', (res) => reject(new Error(`answered ${res.statusCode} before the provider call`))),
      );
      try {
        req.end(payload);

        await Promise.race([atProvider, answeredFirst]);
        expect(providerSignal?.aborted).toBe(false);
        req.destroy();
        await new Promise<void>((resolve) => providerSignal?.addEventListener('abort', () => resolve(), { once: true }));
        expect(providerSignal?.aborted).toBe(true);
      } finally {
        req.destroy();
        answeredFirst.catch(() => undefined);
      }
    });

    it('names the provider on the Assign response', async () => {
      const res = await client(app, newUser()).assign(csvOf(fiveThreeOne(0, 6)));
      expect(res.json<ImportAssignResponse>().suggestions).toEqual({ provider: 'test-model at 127.0.0.1:9' });
    });

    it('returns validated suggestions, and sends notes only when asked', async () => {
      const api = client(app, newUser());
      const csv = csvOf([...fiveThreeOne(0, 8, { notes: 'easy day' }), ...fiveThreeOne(44, 6)]);
      answer = {
        suggestions: [
          { kind: 'boundary', action: 'add', date: day(8), reason: 'weights dropped' },
          { kind: 'boundary', action: 'add', date: '1999-01-01', reason: 'x' },
          { kind: 'note', text: 'x', lifts: ['Clean and Jerk'] },
        ],
      };

      const res = await api.suggest(csv);
      expect(res.statusCode).toBe(200);
      expect(res.json<ImportSuggestionsResponse>()).toEqual({
        status: 'ready',
        provider: 'test-model at 127.0.0.1:9',
        notesSent: false,
        summarizedSessions: 0,
        suggestions: [{ kind: 'boundary', action: 'add', date: day(8), reason: 'weights dropped' }],
        dropped: { malformed: 0, 'unknown-lift': 1, 'out-of-range': 1 },
      });
      expect(JSON.stringify(payloadOf())).not.toContain('easy day');

      await api.suggest(csv, { notes: '1' });
      expect(JSON.stringify(payloadOf(1))).toContain('easy day');
    });

    it(`makes no provider call for the ${IMPORT_SUGGESTION_HOURLY_LIMIT + 1}th request in an hour`, async () => {
      const api = client(app, newUser());
      const csv = csvOf(fiveThreeOne(0, 6));
      for (let i = 0; i < IMPORT_SUGGESTION_HOURLY_LIMIT; i++) {
        expect((await api.suggest(csv)).json<ImportSuggestionsResponse>().status).toBe('ready');
      }

      const res = await api.suggest(csv);
      expect(res.json<ImportSuggestionsResponse>()).toEqual({ status: 'limited', retryAfterMinutes: 60 });
      expect(calls).toHaveLength(IMPORT_SUGGESTION_HOURLY_LIMIT);

      // The limit is per lifter.
      expect((await client(app, newUser()).suggest(csv)).json<ImportSuggestionsResponse>().status).toBe('ready');
    });

    it('sends every set only around breaks and flags for a file over 1,500 sets', async () => {
      // Two runs of 20 sessions with 40 sets each (1,600), a 32-day break between them.
      const csv = csvOf([...fiveThreeOne(0, 20, { sets: 20 }), ...fiveThreeOne(70, 20, { sets: 20 })]);
      const res = await client(app, newUser()).suggest(csv);

      expect(res.json<ImportSuggestionsResponse>()).toMatchObject({ status: 'ready', summarizedSessions: 36 });
      const full = payloadOf().sessions.filter((s) => 'sets' in s).map((s) => s.date);
      expect(full).toEqual([day(36), day(38), day(70), day(72)]);
    });

    it('makes no call for a file still over 1,500 sets after reducing it', async () => {
      // Lifts in no known program, so every set of every session must go: 1,800.
      const sessions = Array.from({ length: 30 }, (_, i) => ({ day: i * 2, lifts: ['Front Squat', 'Hip Thrust'], sets: 30 }));
      const res = await client(app, newUser()).suggest(csvOf(sessions));

      expect(res.json<ImportSuggestionsResponse>()).toEqual({ status: 'too-large', sets: 1_800, limit: 1_500 });
      expect(calls).toHaveLength(0);
    });
  });
});
