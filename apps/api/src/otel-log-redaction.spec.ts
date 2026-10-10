import { Writable } from 'stream';
import pino from 'pino';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  InMemoryLogRecordExporter,
} from '@opentelemetry/sdk-logs';
import { logs } from '@opentelemetry/api-logs';
// Deep import: OTelPinoStream is instrumentation-pino's internal mechanism for
// bridging Pino's serialized log line into an OTel LogRecord. It isn't part of
// the package's public entry point, but it's exactly the code path otel.ts's
// logRecordProcessors activates in production via getNodeAutoInstrumentations().
import { OTelPinoStream } from '@opentelemetry/instrumentation-pino/build/src/log-sending-utils';
import { pinoHttpOptions } from './app.module';

// Regression coverage for issue #662: wiring OTLP log export must not reopen the
// leak app.module.ts's redact config closes. instrumentation-pino's OTel stream
// only ever sees Pino's already-serialized output (fed via pino.multistream() in
// production, fed directly here for a fast, network-free test), so if redaction
// holds on the wire it holds for the OTel Logs pipeline too — this test proves
// both halves of that chain rather than trusting it from reading source alone.
describe('OTel log export does not leak redacted fields', () => {
  const SECRET_TOKEN = 'super-secret-jwt-value';
  const SECRET_COOKIE = 'session=super-secret-cookie-value';
  const SECRET_CLERK_JWT = 'super-secret-clerk-jwt-value';

  it('keeps Authorization/Cookie/X-Clerk-Authorization values out of both the Pino wire format and the resulting OTel LogRecord', async () => {
    // 1. Log a request/response pair shaped like pino-http's own serialization,
    // through the app's REAL redact config, and capture the exact line pino
    // would have written to stdout.
    const chunks: string[] = [];
    const capture = new Writable({
      write(chunk: Buffer, _enc, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino(pinoHttpOptions, capture);
    logger.error(
      {
        req: {
          method: 'POST',
          url: '/programs/x/macrocycles/initialize',
          headers: {
            authorization: `Bearer ${SECRET_TOKEN}`,
            cookie: SECRET_COOKIE,
            // Server-to-server calls (apps/web/lib/api.ts) carry the Clerk JWT
            // here instead of `authorization` — see auth.guard.ts. Regression
            // coverage for #767: this leaked into GCP Cloud Logging in plaintext
            // because it wasn't in the original redact.paths list.
            'x-clerk-authorization': `Bearer ${SECRET_CLERK_JWT}`,
          },
        },
        res: { statusCode: 500 },
        err: new Error('42501: new row violates row-level security policy'),
      },
      'request errored',
    );
    const serializedLine = chunks.join('');

    expect(serializedLine).not.toContain(SECRET_TOKEN);
    expect(serializedLine).not.toContain(SECRET_COOKIE);
    expect(serializedLine).not.toContain(SECRET_CLERK_JWT);
    // Sanity check: the line is real content, not an empty/broken write.
    expect(serializedLine).toContain('42501');

    // 2. Feed that already-redacted line into the same stream instrumentation-pino
    // installs, and confirm it carries the line forward faithfully rather than
    // reconstructing headers from anywhere else.
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(exporter)],
    });
    logs.setGlobalLoggerProvider(provider);

    const probe = pino();
    const otelStream = new OTelPinoStream({
      messageKey: 'msg',
      errorKey: 'err',
      levels: probe.levels,
      // pino's default time function is epochTime — this mirrors it directly
      // rather than reimplementing getTimeConverter()'s pino-internals lookup.
      otelTimestampFromTime: (time: number) => time,
    });

    await new Promise<void>((resolve, reject) => {
      otelStream.write(serializedLine, (err?: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
    await provider.forceFlush();

    const [record] = exporter.getFinishedLogRecords();
    expect(record).toBeDefined();
    const serializedRecord = JSON.stringify(record);

    expect(serializedRecord).not.toContain(SECRET_TOKEN);
    expect(serializedRecord).not.toContain(SECRET_COOKIE);
    expect(serializedRecord).not.toContain(SECRET_CLERK_JWT);

    await provider.shutdown();
  });
});
