import 'reflect-metadata';
import http from 'node:http';
import { Writable } from 'stream';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import { AppModule, pinoHttpOptions } from '../app.module';
import { OpenAICompatibleImportSuggestionsAdapter } from '../adapters/llm/openai-compatible-import-suggestions.adapter';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

/**
 * In-memory E2E for the supplement suggestion routes (#1381) with an AI provider configured. The
 * provider's call is replaced by a spy on the adapter and the label database's by a spy on fetch,
 * so nothing leaves the process. The request log goes through the real pino-http options into
 * `lines`, to check what a request's log line carries.
 */

const ENV = ['IMPORT_SUGGESTIONS_PROVIDER', 'IMPORT_SUGGESTIONS_MODEL', 'IMPORT_SUGGESTIONS_BASE_URL', 'IMPORT_SUGGESTIONS_API_KEY'] as const;
const TYPED = 'Zorblax Ultra Secret Blend';

const lines: Array<{ msg?: string; req?: { url?: string } }> = [];
const rawLines: string[] = [];
const capture = new Writable({
  write(chunk: Buffer, _enc, callback) {
    rawLines.push(chunk.toString());
    lines.push(JSON.parse(chunk.toString()));
    callback();
  },
});

describe('Supplement suggestion routes (#1381, e2e, in-memory adapters, provider set)', () => {
  let app: NestFastifyApplication;
  let providerChoices: number;
  let nextUser = 0;
  const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const headers = () => ({ authorization: `Bearer supplement-suggestions-e2e-${++nextUser}`, 'content-type': 'application/json' });
  const post = (url: string, body: unknown) =>
    app.getHttpAdapter().getInstance().inject({ method: 'POST', url, headers: headers(), payload: JSON.stringify(body) });

  beforeAll(async () => {
    for (const key of ENV) delete process.env[key];
    Object.assign(process.env, {
      IMPORT_SUGGESTIONS_PROVIDER: 'openai-compatible',
      IMPORT_SUGGESTIONS_MODEL: 'test-model',
      // Never dialled: the adapter's call is replaced below.
      IMPORT_SUGGESTIONS_BASE_URL: 'http://127.0.0.1:9/v1',
    });
    const log = jest.spyOn(Logger.prototype, 'log');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useValue({ pinoHttp: [pinoHttpOptions, capture] })
      .compile();
    // The import and supplement suggestions share one provider, so it is built, and its choice
    // logged, once.
    providerChoices = log.mock.calls.filter(([message]) => String(message).startsWith('Import suggestions use')).length;
    log.mockRestore();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  beforeEach(() => {
    lines.length = 0;
    rawLines.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  it('builds the provider once for the import and supplement suggestions', () => {
    expect(providerChoices).toBe(1);
  });

  it('keeps the typed name out of the request log lines', async () => {
    const outbound = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    jest.spyOn(OpenAICompatibleImportSuggestionsAdapter.prototype, 'suggest').mockResolvedValue({
      output: { suggestion: null },
      inputTokens: 1,
      outputTokens: 1,
      truncated: false,
    });

    const lookup = await post('/supplements/label-lookup', { name: TYPED });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toEqual({ status: 'none' });
    // The name did reach the label database, so its absence below is the log's doing.
    expect(String(outbound.mock.calls[0]?.[0])).toContain('Zorblax');
    expect((await post('/supplements/ai-suggestion', { name: TYPED })).statusCode).toBe(200);

    expect(lines.map((l) => l.req?.url)).toEqual(expect.arrayContaining(['/supplements/label-lookup', '/supplements/ai-suggestion']));
    expect(rawLines.join('\n')).not.toContain('Zorblax');
  });

  it('answers a lookup with no usable name none, and 400s one with no name', async () => {
    const outbound = jest.spyOn(globalThis, 'fetch');
    expect((await post('/supplements/label-lookup', { name: ' \n ' })).json()).toEqual({ status: 'none' });
    expect((await post('/supplements/label-lookup', {})).statusCode).toBe(400);
    expect((await post('/supplements/label-lookup', { name: '' })).statusCode).toBe(400);
    expect((await post('/supplements/label-lookup', { name: ['a', 'b'] })).statusCode).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
  });

  // inject() never closes a socket, so this one listens on a real port and hangs up mid-call.
  it('aborts the provider call when the client disconnects', async () => {
    let reached: () => void = () => undefined;
    const atProvider = new Promise<void>((resolve) => (reached = resolve));
    let providerSignal: AbortSignal | undefined;
    jest.spyOn(OpenAICompatibleImportSuggestionsAdapter.prototype, 'suggest').mockImplementation(
      (_call, signal) =>
        new Promise((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })));
          reached();
        }),
    );
    await app.listen(0, '127.0.0.1');
    const { hostname, port } = new URL(await app.getUrl());
    const req = http.request({ host: hostname, port, method: 'POST', path: '/supplements/ai-suggestion', headers: headers() });
    req.on('error', () => undefined); // the hang-up below
    // A response before the provider is reached (a 4xx, say) fails here with its status, rather
    // than leaving the test to time out.
    const answeredFirst = new Promise<never>((_resolve, reject) =>
      req.on('response', (res) => reject(new Error(`answered ${res.statusCode} before the provider call`))),
    );
    try {
      req.end(JSON.stringify({ name: TYPED }));

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
});
