import {
  FetchGoogleSheetClient,
  GoogleApiError,
  SPREADSHEET_TABS,
  SPREADSHEET_TITLE,
  isTransientGoogleError,
} from './google-sheet.client';

describe('FetchGoogleSheetClient', () => {
  const client = new FetchGoogleSheetClient();
  let fetchMock: jest.SpyInstance;

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('revokes with a POST whose token is in the form body, not the query string (decision 10)', async () => {
    respond(200, {});
    await client.revoke('secret-token');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(url).not.toContain('secret-token');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('token=secret-token');
  });

  it("maps an error to { status, reason }, dropping Google's description and the request", async () => {
    respond(400, { error: 'invalid_grant', error_description: 'Bad Request for code 4/secret-code' });
    const err = await client.exchangeCode({ clientId: 'id', clientSecret: 'shh', redirectUri: 'https://w/cb' }, '4/secret-code', 'v').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.toLog()).toEqual({ status: 400, reason: 'invalid_grant' });
    expect(JSON.stringify(err) + err.message).not.toMatch(/secret-code|shh/);
  });

  it("maps an error body that isn't JSON to reason 'unknown'", async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
    await expect(client.revoke('t')).rejects.toMatchObject({ status: 502, reason: 'unknown' });
  });

  it('creates the spreadsheet with its title and both tabs', async () => {
    respond(200, { spreadsheetId: 'abc', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit' });
    expect(await client.createSpreadsheet('at')).toEqual({ spreadsheetId: 'abc', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit' });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toEqual({
      properties: { title: SPREADSHEET_TITLE },
      sheets: SPREADSHEET_TABS.map((title) => ({ properties: { title } })),
    });
  });

  it('reads a NOT_FOUND as a sheet it cannot open, and a quota 403 as an error (decision 12)', async () => {
    respond(404, { error: { code: 404, status: 'NOT_FOUND' } });
    expect(await client.canOpenSpreadsheet('at', 'gone')).toBe(false);
    respond(403, { error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'rateLimitExceeded' }] } });
    await expect(client.canOpenSpreadsheet('at', 'busy')).rejects.toMatchObject({ status: 403, reason: 'rateLimitExceeded' });
  });

  const errorInfo = (reason: string, metadata: Record<string, string> = {}) => ({
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: 'googleapis.com',
    metadata,
  });

  it.each([
    ['a quota ErrorInfo', errorInfo('RATE_LIMIT_EXCEEDED', { quota_metric: 'sheets.googleapis.com/read_requests' }), 'RATE_LIMIT_EXCEEDED', true],
    ['SERVICE_DISABLED', errorInfo('SERVICE_DISABLED', { service: 'sheets.googleapis.com' }), 'SERVICE_DISABLED', false],
    ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', errorInfo('ACCESS_TOKEN_SCOPE_INSUFFICIENT'), 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', false],
  ])('reads a PERMISSION_DENIED with %s as an error, not a missing sheet', async (_name, detail, reason, transient) => {
    respond(403, { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.Help' }, detail] } });
    const err = await client.canOpenSpreadsheet('at', 'present').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.toLog()).toEqual({ status: 403, reason });
    expect(isTransientGoogleError(err)).toBe(transient);
  });

  it.each([
    ['PERMISSION_DENIED with no reason', { status: 'PERMISSION_DENIED' }],
    ['a lone legacy forbidden', { errors: [{ reason: 'forbidden' }] }],
    ['a legacy notFound', { errors: [{ reason: 'notFound' }] }],
  ])('reads a 403 %s as a sheet it cannot open', async (_name, error) => {
    respond(403, { error: { code: 403, ...error } });
    expect(await client.canOpenSpreadsheet('at', 'gone')).toBe(false);
  });

  it('reads a userRateLimitExceeded 403 and a 403 with no body as errors', async () => {
    respond(403, { error: { code: 403, errors: [{ reason: 'forbidden' }, { reason: 'userRateLimitExceeded' }] } });
    await expect(client.canOpenSpreadsheet('at', 'busy')).rejects.toMatchObject({ status: 403, reason: 'forbidden' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(client.canOpenSpreadsheet('at', 'unknown')).rejects.toMatchObject({ status: 403, reason: 'unknown' });
  });

  it('counts a timeout, a 429 and a 5xx as transient, and a 400 or 401 as not', () => {
    for (const status of [0, 429, 500, 503]) expect(isTransientGoogleError(new GoogleApiError(status, 'x'))).toBe(true);
    for (const status of [400, 401, 404]) expect(isTransientGoogleError(new GoogleApiError(status, 'x'))).toBe(false);
    expect(isTransientGoogleError(new Error('not Google'))).toBe(false);
  });
});
