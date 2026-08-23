// Verifies the browser API client resolves its base URL from the runtime-injected
// window.__PUBLIC_CONFIG__ rather than a build-time constant (#396 / ADR-028). The base
// URL is a thunk, so it is read per request — setting the window global before the call
// is sufficient.

describe('client-api runtime base URL', () => {
  const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit?]>();

  // jsdom has no Fetch `Response` global; unskipWorkout is a DELETE whose client path
  // only reads res.ok / res.status (204 → returns undefined), so a minimal stub suffices.
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete window.__PUBLIC_CONFIG__;
    jest.resetModules();
  });

  async function importClientApi(): Promise<typeof import('../client-api')> {
    let mod: typeof import('../client-api') | undefined;
    await jest.isolateModulesAsync(async () => {
      mod = await import('../client-api');
    });
    if (!mod) throw new Error('client-api module failed to load');
    return mod;
  }

  function firstCall(): [string, RequestInit] {
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    return [call[0], call[1] ?? {}];
  }

  it('prefixes requests with the injected apiUrl', async () => {
    window.__PUBLIC_CONFIG__ = { apiUrl: 'https://injected.example', defaultProgram: '5-3-1' };
    const { unskipWorkout } = await importClientApi();

    await unskipWorkout('5-3-1', 1, 2);

    const [url] = firstCall();
    expect(url).toBe('https://injected.example/programs/5-3-1/cycles/1/workouts/2/skip');
  });

  it('sends the dev bearer token only for a non-Cloud-Run (http) apiUrl', async () => {
    window.__PUBLIC_CONFIG__ = {
      apiUrl: 'http://localhost:3004',
      defaultProgram: '5-3-1',
      devAuthToken: 'dev-user',
    };
    const { unskipWorkout } = await importClientApi();

    await unskipWorkout('5-3-1', 1, 2);

    const [url, init] = firstCall();
    expect(url).toBe('http://localhost:3004/programs/5-3-1/cycles/1/workouts/2/skip');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer dev-user');
  });

  it('omits the dev token on a Cloud Run (https) apiUrl even when one is present', async () => {
    window.__PUBLIC_CONFIG__ = {
      apiUrl: 'https://api.prod.example',
      defaultProgram: '5-3-1',
      devAuthToken: 'dev-user',
    };
    const { unskipWorkout } = await importClientApi();

    await unskipWorkout('5-3-1', 1, 2);

    const [, init] = firstCall();
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  // #933: getClientAuthHeaders previously awaited the injected Clerk getToken() with no
  // timeout and no try/catch at all — a hang there blocked the request indefinitely, the
  // same externally-observable bug #922/#932 fixed for a hung fetch() itself, just one
  // layer earlier. It must now degrade to "no token" instead of hanging forever.
  it('proceeds without an Authorization header when the Clerk token getter hangs past the timeout', async () => {
    window.__PUBLIC_CONFIG__ = { apiUrl: 'https://api.prod.example', defaultProgram: '5-3-1' };
    const { unskipWorkout, setAuthTokenGetter } = await importClientApi();
    setAuthTokenGetter(() => new Promise<string | null>(() => {})); // never resolves

    jest.useFakeTimers();
    try {
      const result = unskipWorkout('5-3-1', 1, 2);
      await jest.advanceTimersByTimeAsync(2000); // past the 2s Clerk-token bound
      await expect(result).resolves.toBeUndefined();

      const [, init] = firstCall();
      expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
