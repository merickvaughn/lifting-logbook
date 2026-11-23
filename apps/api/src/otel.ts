import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { redactSpreadsheetIdAttributes } from './google-sheet/span-redaction';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
// @prisma/instrumentation@5.x directly instantiates sdk-trace-base's Span class,
// which was made package-private in sdk-trace-base@2.x — causing "Span is not a
// constructor" at $connect(). PrismaInstrumentation is excluded from the
// instrumentations array until the Prisma v6 upgrade. See ADR-024 and issue #348.

// OTel semantic-convention key for the deployment environment. Stable semconv
// uses `deployment.environment.name`; the OTLP→Prometheus translation in the
// collector promotes it to the Mimir label `deployment_environment_name`, which
// the production alert rules in infra/observability/alerts/api.yaml match on so
// staging telemetry (shared free-tier Grafana Cloud stack) never pages. See #487.
export const DEPLOYMENT_ENVIRONMENT_ATTR = 'deployment.environment.name';

/**
 * Resolve the deployment environment from NODE_ENV. The API container's NODE_ENV
 * is set per environment (`production` / `staging`) by the Helm values and the
 * Cloud Run service spec; locally it is unset, so we fall back to `development`.
 * Pure and exported so the resource attribute is unit-testable without starting
 * the SDK (#487 AC: "assertion that the resource attribute is set").
 *
 * This is the canonical copy. apps/web/instrumentation.ts mirrors this logic
 * inline (separate workspace); keep the two in sync — see the note there.
 */
export function resolveDeploymentEnvironment(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string {
  return nodeEnv && nodeEnv.trim() !== '' ? nodeEnv.trim() : 'development';
}

/**
 * Compose the value for OTEL_RESOURCE_ATTRIBUTES (comma-separated `key=value`
 * pairs per the OTel spec), appending `deployment.environment.name` while
 * preserving any pre-existing value. The SDK's default env detector turns this
 * into a resource attribute on every span/metric/log.
 *
 * We attach the attribute via this env var rather than importing
 * `resourceFromAttributes` from @opentelemetry/resources: @prisma/instrumentation
 * (kept as a dependency per ADR-024) drags a nested resources@1.x into
 * apps/api/node_modules that has no such export, so a direct import resolves to
 * the v1 types under `nest build` and fails with TS2724 (#487).
 */
export function buildResourceAttributesEnv(
  existing: string | undefined = process.env.OTEL_RESOURCE_ATTRIBUTES,
  nodeEnv?: string,
): string {
  const pair = `${DEPLOYMENT_ENVIRONMENT_ATTR}=${resolveDeploymentEnvironment(nodeEnv)}`;
  return existing && existing.trim() !== '' ? `${existing},${pair}` : pair;
}

// Value of OTEL_TRACES_SAMPLER the API runs with unless the environment sets one.
// See the comment in startOtel() and ADR-020's #1343 amendment.
const DEFAULT_TRACES_SAMPLER = 'always_on';

let sdk: NodeSDK | undefined;

/**
 * Builds the log record processor(s) passed to NodeSDK's `logRecordProcessors`
 * option. Activates the log-sending half of @opentelemetry/instrumentation-pino
 * (pulled in transitively by getNodeAutoInstrumentations() below): that
 * instrumentation patches Pino via pino.multistream() to fan every log line out
 * to both stdout and the OTel Logs API, but only once a real LoggerProvider
 * exists — NodeSDK.start() registers one globally as soon as logRecordProcessors
 * is set. Without this, structured logs (including the err.message/err.stack
 * Postgres error detail alerting depends on) never reached the collector's logs
 * pipeline despite it being fully wired to receive them. See issue #662.
 *
 * Safe from a redaction standpoint: instrumentation-pino's OTel stream reads the
 * already-serialized JSON line via multistream, which runs *after* Pino's own
 * redact() has already stripped req.headers.authorization/cookie (see
 * app.module.ts) — both stdout and the OTel stream receive the same,
 * already-redacted line. Locked by otel-log-redaction.spec.ts.
 *
 * Extracted (rather than inlined in startOtel()) so otel.spec.ts can assert this
 * wiring exists independently of exercising the full SDK.
 */
export function buildLogRecordProcessors() {
  return [new BatchLogRecordProcessor(new OTLPLogExporter())];
}

export function startOtel(): NodeSDK | undefined {
  if (process.env.OTEL_SDK_DISABLED === 'true') return undefined;
  if (sdk) return sdk;

  // Exporters env-resolve OTEL_EXPORTER_OTLP_ENDPOINT (base) per the OTLP spec
  // and append /v1/traces or /v1/metrics; OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or
  // OTEL_EXPORTER_OTLP_METRICS_ENDPOINT (full URL) override per-signal.
  // Set deployment.environment.name before constructing the SDK so the default
  // env-based resource detector picks it up (see buildResourceAttributesEnv).
  process.env.OTEL_RESOURCE_ATTRIBUTES = buildResourceAttributesEnv();

  // Sampler: record every request and let the collector decide what to keep.
  // The SDK default, parentbased_always_on, obeys the caller's `traceparent`
  // flag, and Cloud Run's front end stamps browser-originated requests with
  // "not sampled" (-00) — so the API recorded nothing for imports or client
  // writes and the collector's tail-sampling policies (ADR-020: errors, slow,
  // probabilistic) never saw them (#1343). always_on still joins the caller's
  // trace (same trace ID, caller's span as parent); it only ignores the
  // caller's keep/drop verdict, which belongs to the collector. An operator who
  // sets OTEL_TRACES_SAMPLER explicitly keeps that choice; a blank value counts
  // as unset, since the SDK would otherwise fall back to its parent-based default.
  process.env.OTEL_TRACES_SAMPLER ||= DEFAULT_TRACES_SAMPLER;

  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'lifting-logbook-api',
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
      }),
    ],
    logRecordProcessors: buildLogRecordProcessors(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // A Sheets call's URL carries the spreadsheet ID (#1432, ADR-047 decision 24).
        '@opentelemetry/instrumentation-undici': { startSpanHook: redactSpreadsheetIdAttributes },
      }),
    ],
  });

  sdk.start();

  const shutdown = () => {
    // allow-skewed: SIGTERM/SIGINT shutdown handler — no business path to assert against.
    sdk?.shutdown().catch(() => undefined);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return sdk;
}

if (process.env.OTEL_SDK_AUTOSTART !== 'false') {
  try {
    startOtel();
  } catch (err) {
    // An OTel init failure must not kill the process — the app should start
    // without instrumentation rather than crash before NestJS can log anything.
    console.error('[otel] Failed to initialize OpenTelemetry SDK — continuing without instrumentation:', err);
  }
}
