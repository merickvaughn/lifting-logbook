/**
 * @jest-environment node
 */
import { ApiClientError } from '@lifting-logbook/api-client';
import { completeGoogleSheetLink } from '@/lib/api';
import { GET } from './route';

jest.mock('@/lib/api', () => ({ completeGoogleSheetLink: jest.fn() }));

const complete = completeGoogleSheetLink as jest.Mock;
const get = (query: string) => GET(new Request(`http://localhost/settings/data/google-sheet/callback${query}`));
const apiError = (status: number, error: string) => new ApiClientError('x', status, undefined, { error });

describe('GET /settings/data/google-sheet/callback', () => {
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  /** Everything passed to console.error, as one string, to look for what must never be logged. */
  const logged = () => JSON.stringify(consoleError.mock.calls);

  it('posts code and state, then redirects without them', async () => {
    complete.mockResolvedValue({ status: 'linked' });
    const res = await get('?code=4%2Fabc&state=st8&scope=x');

    expect(complete).toHaveBeenCalledWith('4/abc', 'st8');
    expect(res.status).toBe(303);
    const location = res.headers.get('Location');
    expect(location).toBe('/settings/data?google_sheet=linked');
    expect(location).not.toMatch(/code|state=/);
  });

  it.each([
    ['access_denied from Google', '?error=access_denied&state=s', 'denied'],
    ['access_denied alongside a code', '?error=access_denied&code=c&state=s', 'denied'],
    ['a missing code', '?state=s', 'expired'],
    ['a missing state', '?code=c', 'expired'],
  ])('redirects with a message for %s, without calling the API', async (_n, query, result) => {
    const res = await get(query);
    expect(complete).not.toHaveBeenCalled();
    expect(res.headers.get('Location')).toBe(`/settings/data?google_sheet=${result}`);
  });

  it.each(['server_error', 'temporarily_unavailable', 'invalid_scope', ''])(
    'treats Google’s error %p other than access_denied as a failure, and logs only that value',
    async (googleError) => {
      const res = await get(`?error=${googleError}&code=SECRET-CODE&state=SECRET-STATE`);
      expect(complete).not.toHaveBeenCalled();
      expect(res.headers.get('Location')).toBe('/settings/data?google_sheet=failed');
      expect(logged()).not.toMatch(/SECRET/);
      if (googleError) expect(logged()).toContain(googleError);
    },
  );

  it('logs an error value that isn’t a Google code as “other”', async () => {
    await get('?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(logged()).toContain('other');
    expect(logged()).not.toContain('script');
  });

  it.each([
    ['an expired or foreign state', apiError(400, 'google-sheet-state-invalid'), 'expired'],
    ['a missing drive.file grant', apiError(403, 'google-sheet-scope-not-granted'), 'scope'],
    ['a Google failure', apiError(502, 'google-sheet-google-error'), 'failed'],
    ['no Clerk session reaching the API', new ApiClientError('x', 401, undefined, { error: 'Unauthorized' }), 'signin'],
    ['an unconfigured API', apiError(503, 'google-sheet-unconfigured'), 'failed'],
    ['a 5xx with a body that isn’t JSON (none was parsed)', new ApiClientError('x', 502), 'failed'],
    ['a network failure', new Error('down'), 'failed'],
  ])('redirects with a message for %s', async (_n, err, result) => {
    complete.mockRejectedValue(err);
    const res = await get('?code=4%2Fabc&state=st8');
    expect(res.headers.get('Location')).toBe(`/settings/data?google_sheet=${result}`);
    // The single-use values never reach the log.
    expect(logged()).not.toContain('4/abc');
    expect(logged()).not.toContain('4%2Fabc');
    expect(logged()).not.toContain('st8');
  });

  it('logs the status and the API’s error name', async () => {
    complete.mockRejectedValue(apiError(403, 'google-sheet-scope-not-granted'));
    await get('?code=c&state=s');
    expect(consoleError).toHaveBeenCalledWith('[google-sheet-callback] link failed', {
      status: 403,
      error: 'google-sheet-scope-not-granted',
    });
  });

  it('never puts anything it was sent into the Location', async () => {
    complete.mockResolvedValue({ status: 'linked' });
    const res = await get('?code=c&state=a%26b%0D%0ASet-Cookie%3A%20x%3D1&error=oops%26google_sheet%3Dlinked');
    const location = res.headers.get('Location');
    expect(location).toBe('/settings/data?google_sheet=failed');
    expect(location).not.toMatch(/oops|Set-Cookie|a&b/i);

    const withoutError = await get('?code=c&state=a%26b%0D%0ASet-Cookie%3A%20x%3D1');
    expect(withoutError.headers.get('Location')).toBe('/settings/data?google_sheet=linked');
  });
});
