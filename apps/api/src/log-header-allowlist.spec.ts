import { Writable } from 'stream';
import pino from 'pino';
import { pinoHttpOptions, LOGGABLE_REQUEST_HEADERS } from './app.module';

// Guard test for issue #780. The API's request/response header logging is
// redact-by-default: app.module.ts's pino serializers keep only the headers
// named in LOGGABLE_REQUEST_HEADERS and drop everything else. These tests lock
// that contract in both directions so the x-clerk-authorization leak class
// (#767) — an auth header forgotten from a denylist — cannot recur:
//   1. nothing credential-bearing is ever added to the allowlist, and
//   2. an arbitrary auth header, even one nobody has named yet, never reaches
//      the serialized log line.
describe('request/response header logging is redact-by-default (allowlist)', () => {
  // Header-name shapes that carry credentials or session material and must
  // never be logged. Superset of the sensitivity pattern named in issue #780
  // (authorization|token|cookie|api[-_]?key|secret).
  const SENSITIVE_NAME =
    /authorization|token|cookie|api[-_]?key|secret|credential|session|signature|bearer/i;

  function captureLogger() {
    const chunks: string[] = [];
    const capture = new Writable({
      write(chunk: Buffer, _enc, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    return { logger: pino(pinoHttpOptions, capture), line: () => chunks.join('') };
  }

  it('never allowlists a header whose name looks credential-bearing', () => {
    // If a future change adds e.g. `x-api-key` to LOGGABLE_REQUEST_HEADERS
    // (mistaking it for safe to log), this fails the build rather than shipping
    // the leak.
    for (const header of LOGGABLE_REQUEST_HEADERS) {
      expect(header).not.toMatch(SENSITIVE_NAME);
    }
  });

  it('drops arbitrary auth-bearing request headers — including ones the config never names', () => {
    const { logger, line } = captureLogger();

    // A mix of headers we already redact by name (authorization, cookie,
    // x-clerk-authorization) and NOVEL ones a denylist would have missed: a
    // future API-key header, a generic bearer-token header, a proxy-auth
    // header, and a webhook signature. None are allowlisted, so all must drop.
    const secretValues = {
      authorization: 'Bearer known-jwt-value',
      'x-clerk-authorization': 'Bearer clerk-jwt-value',
      cookie: 'session=known-cookie-value',
      'x-api-key': 'ak_live_novel_api_key',
      'x-auth-token': 'novel-auth-token-value',
      'proxy-authorization': 'Basic bm92ZWwtcHJveHk=',
      'x-webhook-signature': 'sha256=novel-signature-value',
    };

    logger.info(
      {
        req: {
          method: 'POST',
          url: '/programs/x/macrocycles/initialize',
          headers: {
            ...secretValues,
            // An allowlisted header, to prove the serializer filters rather
            // than blanket-drops every header.
            'content-type': 'application/json',
          },
        },
      },
      'request received',
    );
    const serializedLine = line();

    for (const value of Object.values(secretValues)) {
      expect(serializedLine).not.toContain(value);
    }
    expect(serializedLine).toContain('application/json');
  });

  it('drops non-allowlisted response headers such as set-cookie', () => {
    const { logger, line } = captureLogger();

    logger.info(
      {
        // pino's standard response serializer reads headers via
        // res.getHeaders(), the way a real Node/Fastify ServerResponse exposes
        // them — mirror that here rather than a plain `headers` property, which
        // the serializer ignores.
        res: {
          statusCode: 200,
          headersSent: true,
          getHeaders: () => ({
            'set-cookie': 'session=leaked-response-cookie',
            'content-type': 'application/json',
          }),
        },
      },
      'request completed',
    );
    const serializedLine = line();

    expect(serializedLine).not.toContain('leaked-response-cookie');
    expect(serializedLine).toContain('application/json');
  });
});
