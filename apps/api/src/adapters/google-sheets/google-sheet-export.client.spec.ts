import { downloadGoogleSheetXlsx, GoogleSheetFetchError, workbookExportUrl } from './google-sheet-export.client';

const ID = '15s6_k614x9FzQtHxQDxh82CjDKYqHaS-VZtmS0he-8Q';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function redirect(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GoogleSheetFetchError) return err.code;
    throw err;
  }
  throw new Error('expected a GoogleSheetFetchError');
}

describe('downloadGoogleSheetXlsx', () => {
  const fetchMock = jest.fn<Promise<Response>, [URL, RequestInit]>();

  beforeEach(() => {
    fetchMock.mockReset();
    jest.spyOn(global, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
  });

  afterEach(() => jest.restoreAllMocks());

  it('requests the export URL built from the ID and follows an allowed redirect', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://doc-0s-4k-sheets.googleusercontent.com/export/abc'))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': XLSX } }));

    const buffer = await downloadGoogleSheetXlsx(ID);

    expect([...buffer]).toEqual([1, 2, 3]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(workbookExportUrl(ID));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://doc-0s-4k-sheets.googleusercontent.com/export/abc');
  });

  it('refuses to follow a redirect to a host outside the allowlist', async () => {
    fetchMock.mockResolvedValueOnce(redirect('https://169.254.169.254/latest/meta-data'));
    expect(await codeOf(downloadGoogleSheetXlsx(ID))).toBe('upstream');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a lookalike googleusercontent host', async () => {
    fetchMock.mockResolvedValueOnce(redirect('https://evilgoogleusercontent.com/x'));
    expect(await codeOf(downloadGoogleSheetXlsx(ID))).toBe('upstream');
  });

  it('reports a private sheet when Google redirects to sign-in', async () => {
    fetchMock.mockResolvedValueOnce(redirect('https://accounts.google.com/ServiceLogin?continue=x'));
    expect(await codeOf(downloadGoogleSheetXlsx(ID))).toBe('not-shared');
  });

  it('reports a private sheet when Google serves an HTML page instead of a workbook', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    expect(await codeOf(downloadGoogleSheetXlsx(ID))).toBe('not-shared');
  });

  it.each([
    [401, 'not-shared'],
    [403, 'not-shared'],
    [404, 'not-found'],
    [500, 'upstream'],
  ])('maps HTTP %s to %s', async (status, code) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    expect(await codeOf(downloadGoogleSheetXlsx(ID))).toBe(code);
  });

  it('cancels the unread body of a response it rejects', async () => {
    const res = new Response('<html>sign in</html>', { status: 403 });
    if (!res.body) throw new Error('expected a response body');
    const cancel = jest.spyOn(res.body, 'cancel');
    fetchMock.mockResolvedValueOnce(res);
    expect(await codeOf(downloadGoogleSheetXlsx(ID))).toBe('not-shared');
    expect(cancel).toHaveBeenCalled();
  });

  it('stops after too many redirects', async () => {
    fetchMock.mockResolvedValue(redirect('https://docs.google.com/spreadsheets/d/x/export'));
    expect(await codeOf(downloadGoogleSheetXlsx(ID))).toBe('upstream');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('aborts a body that grows past the size cap', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(64), { headers: { 'content-type': XLSX } }));
    expect(await codeOf(downloadGoogleSheetXlsx(ID, { maxBytes: 16 }))).toBe('too-large');
  });

  it('rejects a declared content-length over the size cap without reading the body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { headers: { 'content-type': XLSX, 'content-length': '999' } }));
    expect(await codeOf(downloadGoogleSheetXlsx(ID, { maxBytes: 16 }))).toBe('too-large');
  });

  it('times out a slow response', async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    expect(await codeOf(downloadGoogleSheetXlsx(ID, { timeoutMs: 10 }))).toBe('timeout');
  });
});
