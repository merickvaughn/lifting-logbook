// Regression coverage for #1343: browser-originated API requests recorded no
// spans. Cloud Run's front end stamps them with a `traceparent` whose flags say
// "not sampled" (-00), and the SDK's default `parentbased_always_on` sampler
// honoured that flag, so the API never exported the span and the collector's
// tail-sampling policies (ADR-020) never saw the request.
//
// These tests drive the real SDK startup (startOtel) and read the global tracer
// provider it registers, so they fail if the sampler wiring in otel.ts is removed
// or changed back — not merely if a helper still exists.
process.env.OTEL_SDK_AUTOSTART = 'false';
delete process.env.OTEL_SDK_DISABLED;
// A blank value (for example an unset Helm value rendered as "") must count as
// unset: with `??=` it would survive and the SDK would fall back to its
// parent-based default.
process.env.OTEL_TRACES_SAMPLER = '';
delete process.env.OTEL_TRACES_SAMPLER_ARG;
// No collector runs under test; keep the exporters from doing anything noisy.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1';

import {
  ROOT_CONTEXT,
  TraceFlags,
  propagation,
  trace,
  type Span,
} from '@opentelemetry/api';

import { startOtel } from './otel';

// Stands in for the OTLP trace exporter so the spec can assert what the SDK
// actually hands to its exporter, with no collector and no network.
const mockExported: Array<{ traceId: string; spanId: string; flags: number }> = [];
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    export(
      spans: Array<{ spanContext(): { traceId: string; spanId: string; traceFlags: number } }>,
      done: (result: { code: number }) => void,
    ) {
      for (const s of spans) {
        const c = s.spanContext();
        mockExported.push({ traceId: c.traceId, spanId: c.spanId, flags: c.traceFlags });
      }
      done({ code: 0 });
    }
    shutdown() {
      return Promise.resolve();
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
}));

const TRACE_ID = '108a14ddb263b413a8b4cea156ab3c86';
const INCOMING_SPAN_ID = 'fb7c4ef9a7730fe3';

// Starts a span the way the HTTP instrumentation does for an inbound request:
// extract the caller's context from the `traceparent` header, then start the
// server span as its child.
function startServerSpan(traceparent: string): Span {
  const parent = propagation.extract(ROOT_CONTEXT, { traceparent });
  return trace.getTracer('sampler-spec').startSpan('GET /import', {}, parent);
}

describe('API trace sampler (#1343)', () => {
  const sdk = startOtel();

  it('starts the SDK so the tests below exercise the real configuration', () => {
    expect(sdk).toBeDefined();
  });

  it('records a request whose traceparent says not sampled, and flags the span sampled so it is exported', () => {
    const span = startServerSpan(`00-${TRACE_ID}-${INCOMING_SPAN_ID}-00`);
    try {
      expect(span.isRecording()).toBe(true);
      expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      span.end();
    }
  });

  it('keeps a sampled traceparent from the web server: same trace, incoming span as parent', () => {
    const span = startServerSpan(`00-${TRACE_ID}-${INCOMING_SPAN_ID}-01`);
    try {
      expect(span.isRecording()).toBe(true);
      expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
      expect(span.spanContext().traceId).toBe(TRACE_ID);
      // sdk-trace-base 2.x exposes the parent as `parentSpanContext`.
      const parent = (span as unknown as { parentSpanContext?: { spanId: string } })
        .parentSpanContext;
      expect(parent?.spanId).toBe(INCOMING_SPAN_ID);
    } finally {
      span.end();
    }
  });

  it('keeps the browser request in the caller trace even though its flag said not sampled', () => {
    const span = startServerSpan(`00-${TRACE_ID}-${INCOMING_SPAN_ID}-00`);
    try {
      expect(span.spanContext().traceId).toBe(TRACE_ID);
    } finally {
      span.end();
    }
  });

  it('records a request with no traceparent at all', () => {
    const span = trace.getTracer('sampler-spec').startSpan('GET /health');
    try {
      expect(span.isRecording()).toBe(true);
      expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      span.end();
    }
  });

  // Last on purpose: shutdown flushes the batch span processor into the exporter.
  it('exports the span of a request that arrived with a not-sampled traceparent', async () => {
    const span = startServerSpan(`00-${TRACE_ID}-${INCOMING_SPAN_ID}-00`);
    const { spanId } = span.spanContext();
    span.end();

    await sdk?.shutdown();

    const exported = mockExported.find((e) => e.spanId === spanId);
    expect(exported).toBeDefined();
    expect(exported?.traceId).toBe(TRACE_ID);
    expect(exported?.flags).toBe(TraceFlags.SAMPLED);
  });
});
