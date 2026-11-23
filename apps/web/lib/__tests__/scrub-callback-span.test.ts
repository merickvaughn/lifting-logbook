import { callbackSpanScrubber, scrubCallbackAttributes } from '../scrub-callback-span';

describe('scrubCallbackAttributes', () => {
  it('removes the query string from the callback request’s span URL attributes', () => {
    const attributes: Record<string, unknown> = {
      'http.url': 'https://app.example/settings/data/google-sheet/callback?code=SECRET&state=S2',
      'url.full': 'https://app.example/settings/data/google-sheet/callback?code=SECRET&state=S2',
      'http.target': '/settings/data/google-sheet/callback?code=SECRET&state=S2',
      'url.query': 'code=SECRET&state=S2',
      'http.method': 'GET',
    };
    callbackSpanScrubber.onEnd({ attributes });
    expect(JSON.stringify(attributes)).not.toMatch(/SECRET|S2/);
    expect(attributes['http.url']).toBe('https://app.example/settings/data/google-sheet/callback');
    expect(attributes['http.method']).toBe('GET');
    expect(attributes).not.toHaveProperty('url.query');
  });

  it('leaves other routes’ queries alone', () => {
    const attributes: Record<string, unknown> = { 'http.url': 'https://app.example/settings/data?x=1', 'url.query': 'x=1' };
    scrubCallbackAttributes(attributes);
    expect(attributes).toEqual({ 'http.url': 'https://app.example/settings/data?x=1', 'url.query': 'x=1' });
  });
});
