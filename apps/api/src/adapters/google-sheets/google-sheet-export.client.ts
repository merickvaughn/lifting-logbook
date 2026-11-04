/**
 * Downloads a link-shared Google Sheets workbook as XLSX (#1111).
 *
 * The request URL is built from a spreadsheet ID that `parseGoogleSheetUrl`
 * has already validated; nothing the user pasted is ever fetched directly.
 * Redirects are followed by hand so every hop can be checked against a host
 * allowlist (Google serves the export from `docs.google.com` and redirects to
 * a `*.googleusercontent.com` download host). A hop to the sign-in page means
 * the sheet is not shared with "Anyone with the link".
 */

/** Compressed-size cap. Also bounds how far a hostile archive can inflate. */
export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;
export const WORKBOOK_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export type GoogleSheetFetchErrorCode = 'not-shared' | 'not-found' | 'too-large' | 'timeout' | 'upstream';

export class GoogleSheetFetchError extends Error {
  constructor(
    readonly code: GoogleSheetFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleSheetFetchError';
  }
}

function isAllowedHost(hostname: string): boolean {
  return hostname === 'docs.google.com' || hostname.endsWith('.googleusercontent.com');
}

export function workbookExportUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=xlsx`;
}

export async function downloadGoogleSheetXlsx(
  spreadsheetId: string,
  { timeoutMs = WORKBOOK_FETCH_TIMEOUT_MS, maxBytes = MAX_WORKBOOK_BYTES } = {},
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = new URL(workbookExportUrl(spreadsheetId));
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, { redirect: 'manual', signal: controller.signal });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || hop >= MAX_REDIRECTS) {
          throw new GoogleSheetFetchError('upstream', 'Google Sheets returned too many redirects.');
        }
        const next = new URL(location, url);
        if (next.hostname === 'accounts.google.com') {
          throw notShared();
        }
        if (next.protocol !== 'https:' || !isAllowedHost(next.hostname)) {
          throw new GoogleSheetFetchError('upstream', 'Google Sheets redirected to an unexpected host.');
        }
        url = next;
        continue;
      }

      if (res.status === 401 || res.status === 403) throw notShared();
      if (res.status === 404) {
        throw new GoogleSheetFetchError('not-found', 'No Google Sheet exists at that link.');
      }
      if (!res.ok) {
        throw new GoogleSheetFetchError('upstream', `Google Sheets returned HTTP ${res.status}.`);
      }
      // A sign-in or interstitial page comes back as 200 text/html, not a workbook.
      if ((res.headers.get('content-type') ?? '').includes('text/html')) throw notShared();

      const declared = Number(res.headers.get('content-length'));
      if (declared > maxBytes) throw tooLarge(maxBytes);
      return await readCapped(res, maxBytes);
    }
  } catch (err) {
    if (err instanceof GoogleSheetFetchError) throw err;
    if (controller.signal.aborted) {
      throw new GoogleSheetFetchError('timeout', 'Google Sheets took too long to respond.');
    }
    throw new GoogleSheetFetchError('upstream', 'Could not reach Google Sheets.');
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function notShared(): GoogleSheetFetchError {
  return new GoogleSheetFetchError(
    'not-shared',
    'This sheet is not shared. In Google Sheets, click Share and set General access to "Anyone with the link" (Viewer), then try again.',
  );
}

function tooLarge(maxBytes: number): GoogleSheetFetchError {
  return new GoogleSheetFetchError(
    'too-large',
    `The workbook is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`,
  );
}
