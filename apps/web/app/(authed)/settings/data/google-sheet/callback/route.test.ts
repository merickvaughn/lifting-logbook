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
    ['an error from Google', '?error=access_denied&state=s', 'denied'],
    ['a missing code', '?state=s', 'expired'],
    ['a missing state', '?code=c', 'expired'],
  ])('redirects with a message for %s, without calling the API', async (_n, query, result) => {
    const res = await get(query);
    expect(complete).not.toHaveBeenCalled();
    expect(res.headers.get('Location')).toBe(`/settings/data?google_sheet=${result}`);
  });

  it.each([
    ['an expired or foreign state', apiError(400, 'google-sheet-state-invalid'), 'expired'],
    ['a missing drive.file grant', apiError(403, 'google-sheet-scope-not-granted'), 'scope'],
    ['a Google failure', apiError(502, 'google-sheet-google-error'), 'failed'],
    ['a network failure', new Error('down'), 'failed'],
  ])('redirects with a message for %s', async (_n, err, result) => {
    complete.mockRejectedValue(err);
    const res = await get('?code=c&state=s');
    expect(res.headers.get('Location')).toBe(`/settings/data?google_sheet=${result}`);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('code=');
  });
});
