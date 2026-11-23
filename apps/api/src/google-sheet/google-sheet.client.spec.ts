import { FetchGoogleSheetClient, GoogleApiError, SPREADSHEET_TABS, SPREADSHEET_TITLE } from './google-sheet.client';

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
});
