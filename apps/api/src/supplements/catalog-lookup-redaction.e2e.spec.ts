// Set before any other imports so the production otel.ts does not start its own SDK.
process.env.OTEL_SDK_AUTOSTART = 'false';
process.env.OTEL_SDK_DISABLED = 'true';

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import http from 'node:http';

const exporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
tracerProvider.register();
// Jest loads `http` before this file runs, so the instrumentation's require hook never sees it
// (see observability/otel.e2e.spec.ts). Apply its `http` patch, the one production's SDK applies,
// to the loaded module directly. The cast reaches `_modules`, the module definitions
// InstrumentationBase keeps for its require hook; this throws if that ever moves.
const instrumentation = new HttpInstrumentation();
instrumentation.setTracerProvider(tracerProvider);
type ModuleDefinition = { name: string; patch?: (exports: unknown) => unknown; unpatch?: (exports: unknown) => void };
const httpDefinition = (instrumentation as unknown as { _modules?: ModuleDefinition[] })._modules?.find((d) => d.name === 'http');
if (!httpDefinition?.patch) throw new Error('HttpInstrumentation has no http module definition');
httpDefinition.patch(http);

import 'reflect-metadata';
import { Writable } from 'stream';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import { AppModule, pinoHttpOptions } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

/**
 * #1458: the supplement catalog lookup runs on every typing pause, so the names it carries are ones
 * the lifter never saved. This sends a lookup over a real socket, with the real pino-http options
 * and the HTTP auto-instrumentation, and checks the typed name reaches neither the request log nor
 * the inbound span.
 */

const TYPED = 'Zorblax';
const rawLines: string[] = [];
const capture = new Writable({
  write(chunk: Buffer, _enc, callback) {
    rawLines.push(chunk.toString());
    callback();
  },
});

describe('Supplement catalog lookup redaction (#1458, e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useValue({ pinoHttp: [pinoHttpOptions, capture] })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    // `http` is shared by every suite this worker runs next, so take the patch back off.
    httpDefinition.unpatch?.(http);
    await tracerProvider.shutdown();
  });

  it('keeps the typed name out of the request log line and the inbound span', async () => {
    const { port } = app.getHttpServer().address() as { port: number };
    const payload = JSON.stringify({ name: TYPED });
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/supplements/catalog',
          headers: { authorization: 'Bearer catalog-redaction-e2e', 'content-type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual([]);

    const logLine = rawLines.find((line) => line.includes('/supplements/catalog'));
    expect(logLine).toBeDefined();
    expect(rawLines.join('\n')).not.toContain(TYPED);

    const server = exporter.getFinishedSpans().find((span) => span.kind === 1 /* SpanKind.SERVER */);
    expect(server).toBeDefined();
    const attributes = JSON.stringify(server?.attributes);
    expect(attributes).toContain('/supplements/catalog');
    expect(attributes).not.toContain(TYPED);
  });
});
