import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { buildOtelOptions } from '../otel-options';
import { callbackSpanScrubber, scrubCallbackAttributes } from '../scrub-callback-span';

const CALLBACK = '/settings/data/google-sheet/callback';
const QUERY = 'code=SECRET&state=ST8';

describe('scrubCallbackAttributes', () => {
  it('removes the query string from the callback request’s span URL attributes', () => {
    const attributes: Record<string, unknown> = {
      'http.url': `https://app.example${CALLBACK}?${QUERY}`,
      'url.full': `https://app.example${CALLBACK}?${QUERY}`,
      'http.target': `${CALLBACK}?${QUERY}`,
      'url.query': QUERY,
      'http.method': 'GET',
    };
    callbackSpanScrubber.onEnd({ attributes });
    expect(JSON.stringify(attributes)).not.toMatch(/SECRET|ST8/);
    expect(attributes['http.url']).toBe(`https://app.example${CALLBACK}`);
    expect(attributes['http.method']).toBe('GET');
    expect(attributes).not.toHaveProperty('url.query');
  });

  it('scrubs a span identified only by its route, whose URL attributes don’t name the path', () => {
    for (const route of ['next.route', 'http.route']) {
      const attributes: Record<string, unknown> = {
        [route]: CALLBACK,
        'http.target': `/?${QUERY}`,
        'url.query': QUERY,
      };
      scrubCallbackAttributes(attributes);
      expect(JSON.stringify(attributes)).not.toMatch(/SECRET|ST8/);
    }
  });

  it('scrubs a span whose route carries the (authed) route group', () => {
    const attributes: Record<string, unknown> = {
      'next.route': `/(authed)${CALLBACK}`,
      'url.full': `https://app.example/x?${QUERY}`,
    };
    scrubCallbackAttributes(attributes);
    expect(attributes['url.full']).toBe('https://app.example/x');
  });

  it('scrubs the sign-in redirect that carries the callback URL, plain or percent-encoded', () => {
    const encodedOnce = encodeURIComponent(`${CALLBACK}?${QUERY}`);
    const encodedTwice = encodeURIComponent(encodedOnce);
    const lowerCase = encodedOnce.toLowerCase();
    for (const redirect of [`${CALLBACK}?${QUERY}`, encodedOnce, encodedTwice, lowerCase]) {
      const attributes: Record<string, unknown> = {
        'http.target': `/sign-in?redirect_url=${redirect}`,
        'url.full': `https://app.example/sign-in?redirect_url=${redirect}`,
        'http.url': `https://app.example/sign-in?redirect_url=${redirect}`,
        'url.query': `redirect_url=${redirect}`,
        'http.method': 'GET',
      };
      scrubCallbackAttributes(attributes);
      expect(JSON.stringify(attributes)).not.toMatch(/SECRET|ST8|redirect_url/);
      expect(attributes['http.target']).toBe('/sign-in');
      expect(attributes['url.full']).toBe('https://app.example/sign-in');
      expect(attributes['http.method']).toBe('GET');
    }
  });

  it('leaves other routes’ queries alone, including a sign-in that redirects elsewhere', () => {
    const attributes: Record<string, unknown> = { 'http.url': 'https://app.example/settings/data?x=1', 'url.query': 'x=1' };
    scrubCallbackAttributes(attributes);
    expect(attributes).toEqual({ 'http.url': 'https://app.example/settings/data?x=1', 'url.query': 'x=1' });

    const signIn: Record<string, unknown> = {
      'http.target': `/sign-in?redirect_url=${encodeURIComponent('/settings/data?tab=1')}`,
      'url.query': 'redirect_url=%2Fsettings%2Fdata%3Ftab%3D1',
    };
    const before = { ...signIn };
    scrubCallbackAttributes(signIn);
    expect(signIn).toEqual(before);
  });
});

describe('the span scrubber as registered', () => {
  it('is in the options handed to registerOTel, ahead of the exporter’s processor', () => {
    const processors = buildOtelOptions('test').spanProcessors ?? [];
    const scrubber = processors.indexOf(callbackSpanScrubber);
    const exporter = processors.indexOf('auto');
    expect(scrubber).toBeGreaterThanOrEqual(0);
    expect(exporter).toBeGreaterThan(scrubber);
  });

  it('keeps the service name and the deployment environment', () => {
    const options = buildOtelOptions('staging');
    expect(options.serviceName).toBe('lifting-logbook-web');
    expect(options.attributes).toEqual({ 'deployment.environment.name': 'staging' });
  });

  it('keeps the code and state off a real span before an exporter sees it', async () => {
    const exporter = new InMemorySpanExporter();
    // The same order as the options above: the scrubber first, then what exports.
    const provider = new BasicTracerProvider({
      spanProcessors: [callbackSpanScrubber, new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');

    const callback = tracer.startSpan(`GET ${CALLBACK}`, {
      attributes: {
        'http.method': 'GET',
        'http.target': `${CALLBACK}?${QUERY}`,
        'url.full': `https://app.example${CALLBACK}?${QUERY}`,
        'url.query': QUERY,
      },
    });
    // Next sets some attributes after the span starts.
    callback.setAttribute('http.url', `https://app.example${CALLBACK}?${QUERY}`);
    callback.end();

    const signIn = tracer.startSpan('GET /sign-in', {
      attributes: { 'http.target': `/sign-in?redirect_url=${encodeURIComponent(`${CALLBACK}?${QUERY}`)}` },
    });
    signIn.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(JSON.stringify(span.attributes)).not.toMatch(/SECRET|ST8/);
    }
    expect(spans[0]?.attributes['http.method']).toBe('GET');
    expect(spans[0]?.attributes['http.url']).toBe(`https://app.example${CALLBACK}`);
    await provider.shutdown();
  });

  it('would leak without the scrubber (the check above can fail)', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.getTracer('test').startSpan('GET', { attributes: { 'http.target': `${CALLBACK}?${QUERY}` } }).end();
    expect(JSON.stringify(exporter.getFinishedSpans()[0]?.attributes)).toMatch(/SECRET/);
    await provider.shutdown();
  });
});
