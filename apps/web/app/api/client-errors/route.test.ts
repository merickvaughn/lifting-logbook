/**
 * @jest-environment node
 */

// Mock the OTel API so the handler's span emission is observable without a real
// tracer provider. startSpan returns a shared mock span whose calls we assert.
const span = {
  setAttribute: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};
const startSpan = jest.fn(() => span);
const getTracer = jest.fn(() => ({ startSpan }));

jest.mock('@opentelemetry/api', () => ({
  trace: { getTracer },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

import { POST } from './route';

function post(
  body: string | Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://localhost/api/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });
}

// Flatten the mock span's setAttribute calls into a plain object for assertions.
function attributes(): Record<string, unknown> {
  return Object.fromEntries(
    span.setAttribute.mock.calls.map(([key, value]) => [key, value]),
  );
}

describe('POST /api/client-errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // The same-origin guard reads these at request time; reset so each test starts
    // from the default (observe-only, no allowlist) state.
    delete process.env.CLIENT_ERROR_ALLOWED_ORIGINS;
    delete process.env.CLIENT_ERROR_DROP_CROSS_ORIGIN;
  });

  it('records an ERROR span named client.mutation.error with operation, name, and message', async () => {
    const res = await POST(
      post({ operation: 'rescheduleWorkout', name: 'ApiClientError', message: 'Slot taken' }),
    );

    expect(res.status).toBe(204);
    expect(getTracer).toHaveBeenCalledWith('web-client-errors');
    expect(startSpan).toHaveBeenCalledWith('client.mutation.error');

    const attrs = attributes();
    expect(attrs['client.operation']).toBe('rescheduleWorkout');
    expect(attrs['client.error.name']).toBe('ApiClientError');
    expect(attrs['client.error.message']).toBe('Slot taken');

    expect(span.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 2 }));
    expect(span.recordException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ApiClientError', message: 'Slot taken' }),
    );
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('promotes only scalar context values to client.context.* attributes', async () => {
    await POST(
      post({
        operation: 'upsertLiftOverride',
        message: 'boom',
        context: {
          program: '5-3-1',
          macrocycleNum: 3,
          enabled: true,
          nested: { a: 1 }, // dropped — never serialize nested objects
          list: [1, 2], // dropped
          missing: null, // dropped
        },
      }),
    );

    const attrs = attributes();
    expect(attrs['client.context.program']).toBe('5-3-1');
    expect(attrs['client.context.macrocycleNum']).toBe(3);
    expect(attrs['client.context.enabled']).toBe(true);
    expect(attrs).not.toHaveProperty('client.context.nested');
    expect(attrs).not.toHaveProperty('client.context.list');
    expect(attrs).not.toHaveProperty('client.context.missing');
  });

  it('omits client.error.name when the report has no name (non-Error origin)', async () => {
    await POST(post({ operation: 'undoImport', message: 'a string failure' }));

    const attrs = attributes();
    expect(attrs['client.error.message']).toBe('a string failure');
    expect(attrs).not.toHaveProperty('client.error.name');
  });

  it('defaults operation to "unknown" when the report omits it', async () => {
    await POST(post({ message: 'orphan error' }));
    expect(attributes()['client.operation']).toBe('unknown');
  });

  it('drops a malformed JSON body without emitting a span and never 500s', async () => {
    const res = await POST(post('not valid json{'));

    expect(res.status).toBe(204);
    expect(startSpan).not.toHaveBeenCalled();
  });

  it('drops a non-object JSON body (array) without a span', async () => {
    const res = await POST(post('[1,2,3]'));

    expect(res.status).toBe(204);
    expect(startSpan).not.toHaveBeenCalled();
  });

  it('drops an empty body without a span', async () => {
    const res = await POST(post(''));

    expect(res.status).toBe(204);
    expect(startSpan).not.toHaveBeenCalled();
  });

  it('drops an oversized body (> 4KB) without a span', async () => {
    const res = await POST(post({ operation: 'createLiftRecord', message: 'x'.repeat(5000) }));

    expect(res.status).toBe(204);
    expect(startSpan).not.toHaveBeenCalled();
  });

  it('clamps an over-long string field rather than emitting it wholesale', async () => {
    // 600-char message: under the 4KB body cap, over the 512-char attribute cap.
    await POST(post({ operation: 'skipWorkout', message: 'y'.repeat(600) }));

    const message = attributes()['client.error.message'] as string;
    expect(message).toHaveLength(512);
  });

  it('never 500s when a span operation throws — the outer catch holds and span.end still runs', async () => {
    // The headline guarantee: a telemetry sink must never surface a 500. Force a
    // span op to throw and assert the response is still 204 and end() ran (finally).
    span.setAttribute.mockImplementationOnce(() => {
      throw new Error('otel exploded');
    });

    const res = await POST(post({ operation: 'skipWorkout', message: 'boom' }));

    expect(res.status).toBe(204);
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  describe('same-origin guard (#806)', () => {
    it('tags no-origin and records the span when the request carries no Origin header', async () => {
      const res = await POST(post({ operation: 'skipWorkout', message: 'boom' }));

      expect(res.status).toBe(204);
      expect(startSpan).toHaveBeenCalledTimes(1);
      expect(attributes()['client.origin.check']).toBe('no-origin');
    });

    it('tags same-origin (Host heuristic) when the Origin host matches the Host header', async () => {
      await POST(
        post(
          { operation: 'skipWorkout', message: 'boom' },
          { origin: 'https://app.example.com', host: 'app.example.com' },
        ),
      );

      const attrs = attributes();
      expect(attrs['client.origin.check']).toBe('same-origin');
      expect(attrs).not.toHaveProperty('client.origin.value');
    });

    it('tags cross-origin but STILL records the span in observe mode (no drop configured)', async () => {
      const res = await POST(
        post(
          { operation: 'skipWorkout', message: 'boom' },
          { origin: 'https://evil.example', host: 'app.example.com' },
        ),
      );

      expect(res.status).toBe(204);
      // Observe, not enforce: the span is still recorded — this is the signal used
      // to validate the guard in staging before enforcement is enabled.
      expect(startSpan).toHaveBeenCalledTimes(1);
      const attrs = attributes();
      expect(attrs['client.origin.check']).toBe('cross-origin');
      expect(attrs['client.origin.value']).toBe('https://evil.example');
    });

    it('treats an opaque Origin ("null") as cross-origin under the Host heuristic', async () => {
      await POST(
        post(
          { operation: 'skipWorkout', message: 'boom' },
          { origin: 'null', host: 'app.example.com' },
        ),
      );

      expect(attributes()['client.origin.check']).toBe('cross-origin');
    });

    it('uses the allowlist over the Host header: an allowed Origin is same-origin even when Host differs', async () => {
      // The LB-Host-rewrite false-drop the issue flags: allowlist verdicts ignore Host.
      process.env.CLIENT_ERROR_ALLOWED_ORIGINS = 'https://app.example.com, https://www.example.com';

      await POST(
        post(
          { operation: 'skipWorkout', message: 'boom' },
          { origin: 'https://app.example.com', host: 'internal-lb.local' },
        ),
      );

      expect(attributes()['client.origin.check']).toBe('same-origin');
    });

    it('normalizes a trailing slash in an allowlist entry so a copied "https://host/" still matches', async () => {
      process.env.CLIENT_ERROR_ALLOWED_ORIGINS = 'https://app.example.com/';
      process.env.CLIENT_ERROR_DROP_CROSS_ORIGIN = 'true';

      const res = await POST(
        post(
          { operation: 'skipWorkout', message: 'boom' },
          { origin: 'https://app.example.com', host: 'app.example.com' },
        ),
      );

      // Would be a false-drop if the trailing slash weren't normalized.
      expect(res.status).toBe(204);
      expect(startSpan).toHaveBeenCalledTimes(1);
      expect(attributes()['client.origin.check']).toBe('same-origin');
    });

    it('drops a cross-origin browser beacon without a span when enforcement is on with an allowlist', async () => {
      process.env.CLIENT_ERROR_ALLOWED_ORIGINS = 'https://app.example.com';
      process.env.CLIENT_ERROR_DROP_CROSS_ORIGIN = 'true';

      const res = await POST(
        post(
          { operation: 'skipWorkout', message: 'boom' },
          { origin: 'https://evil.example', host: 'app.example.com' },
        ),
      );

      expect(res.status).toBe(204);
      // Rejected before any span is started — the whole point of the guard.
      expect(startSpan).not.toHaveBeenCalled();
    });

    it('records an allowlisted same-origin beacon under enforcement', async () => {
      process.env.CLIENT_ERROR_ALLOWED_ORIGINS = 'https://app.example.com';
      process.env.CLIENT_ERROR_DROP_CROSS_ORIGIN = 'true';

      await POST(
        post(
          { operation: 'skipWorkout', message: 'boom' },
          { origin: 'https://app.example.com', host: 'app.example.com' },
        ),
      );

      expect(startSpan).toHaveBeenCalledTimes(1);
      expect(attributes()['client.origin.check']).toBe('same-origin');
    });

    it('never drops a no-Origin request even under enforcement (scripted abuse belongs to the infra rate-limit)', async () => {
      process.env.CLIENT_ERROR_ALLOWED_ORIGINS = 'https://app.example.com';
      process.env.CLIENT_ERROR_DROP_CROSS_ORIGIN = 'true';

      const res = await POST(post({ operation: 'skipWorkout', message: 'boom' }));

      expect(res.status).toBe(204);
      expect(startSpan).toHaveBeenCalledTimes(1);
      expect(attributes()['client.origin.check']).toBe('no-origin');
    });

    it('refuses to enforce via the Host heuristic: drop enabled but no allowlist records the span with enforce_skipped', async () => {
      // Safety interlock: without an allowlist the only verdict source is the risky
      // Host heuristic, which must NEVER drop — so the span is recorded, flagged.
      process.env.CLIENT_ERROR_DROP_CROSS_ORIGIN = 'true';

      const res = await POST(
        post(
          { operation: 'skipWorkout', message: 'boom' },
          { origin: 'https://evil.example', host: 'app.example.com' },
        ),
      );

      expect(res.status).toBe(204);
      expect(startSpan).toHaveBeenCalledTimes(1);
      const attrs = attributes();
      expect(attrs['client.origin.check']).toBe('cross-origin');
      expect(attrs['client.origin.enforce_skipped']).toBe(true);
    });
  });
});
