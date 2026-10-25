import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ClsModule } from 'nestjs-cls';
import { trace, context } from '@opentelemetry/api';
import pino from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import { RepositoryFactoryModule } from './adapters/factory/repository-factory.module';
import { AuthModule } from './auth/auth.module';
import { CustomProgramsModule } from './custom-programs/custom-programs.module';
import { FocusModule } from './focus/focus.module';
import { HealthModule } from './health/health.module';
import { LiftsModule } from './lifts/lifts.module';
import { ProgramsModule } from './programs/programs.module';
import { UserSettingsModule } from './user-settings/user-settings.module';

// Exported (rather than inlined below) so otel-log-redaction.spec.ts and
// log-header-allowlist.spec.ts can exercise the exact config this app runs with
// — a copy would drift silently out of sync.

// Request/response headers that are safe to write to long-retention log storage
// (Grafana Cloud Loki). This is an ALLOWLIST: the serializers below drop every
// header not named here, so redaction is the DEFAULT and a newly introduced
// auth-bearing header cannot leak the way x-clerk-authorization leaked full
// Clerk JWTs for weeks (#767). The prior approach was a denylist of specific
// sensitive headers — incomplete-by-design, because it required remembering to
// add each new bearer header by hand (#780).
//
// To log a new header, add its (lowercase) name here. log-header-allowlist.spec.ts
// fails CI if any entry matches a credential-bearing name pattern, so an unsafe
// addition is caught before it ships.
export const LOGGABLE_REQUEST_HEADERS: readonly string[] = [
  'host',
  'user-agent',
  // NB: `referer` is deliberately NOT logged — unlike the other allowlisted
  // headers it is a full URL and can carry secrets in its query string. `origin`
  // is safe (scheme + host only, no path/query) and useful for CORS debugging.
  'origin',
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'content-length',
  'x-request-id',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'traceparent',
  'tracestate',
];

const LOGGABLE_HEADER_SET = new Set<string>(LOGGABLE_REQUEST_HEADERS);

// Returns a new object containing only allowlisted headers, matched
// case-insensitively (Node lowercases inbound header names, but synthetic log
// call sites and tests may not). Never mutates the caller's object.
function allowlistHeaders(headers: unknown): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (headers === null || typeof headers !== 'object') return safe;
  const source = headers as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (LOGGABLE_HEADER_SET.has(key.toLowerCase())) {
      safe[key] = source[key];
    }
  }
  return safe;
}

export const pinoHttpOptions: PinoHttpOptions = {
  // Primary redaction (redact-by-default): run pino's standard req/res
  // serializer, then keep only the LOGGABLE_REQUEST_HEADERS allowlist. Any
  // header not explicitly marked safe — including auth-bearing headers nobody
  // has thought of yet — is dropped rather than logged. Everything else the
  // standard serializer produces (method, url, statusCode, …) is preserved.
  serializers: {
    req(request) {
      const serialized = pino.stdSerializers.req(request);
      return { ...serialized, headers: allowlistHeaders(serialized.headers) };
    },
    res(response) {
      const serialized = pino.stdSerializers.res(response);
      return { ...serialized, headers: allowlistHeaders(serialized.headers) };
    },
  },
  // Defense-in-depth backstop for the highest-risk bearer headers and cookies:
  // if a future refactor removes or bypasses the allowlist serializer above,
  // these explicit paths still strip the known credential carriers. This list
  // is intentionally NOT the primary mechanism and need not grow as new headers
  // are added — the allowlist covers those by default (#767, #780).
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-clerk-authorization"]',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'res.headers["set-cookie"]',
    ],
    remove: true,
  },
  // K8s liveness/readiness probes hit /health on every replica every few
  // seconds; auto-logging that path inflates Grafana Cloud log spend
  // without adding signal.
  autoLogging: {
    ignore: (req) => req.url === '/health',
  },
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
  },
};

@Module({
  imports: [
    // Provides ClsService (AsyncLocalStorage) globally. The RLS interceptor manages the context
    // itself via cls.run() per request, so no auto-mounted middleware/guard is needed here.
    ClsModule.forRoot({ global: true }),
    LoggerModule.forRoot({
      pinoHttp: pinoHttpOptions,
    }),
    AuthModule,
    CustomProgramsModule,
    FocusModule,
    HealthModule,
    LiftsModule,
    ProgramsModule,
    RepositoryFactoryModule,
    UserSettingsModule,
  ],
})
export class AppModule {}
