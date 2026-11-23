import type { Span } from '@opentelemetry/api';

const SHEETS_ORIGIN = 'https://sheets.googleapis.com';
const SPREADSHEET_ID = /(\/spreadsheets\/)[^/?:]+/;

/**
 * The outbound-HTTP span's URL for a Sheets call holds the spreadsheet ID in its path, which
 * ADR-047 decision 24 keeps out of traces (#1432). Wired as instrumentation-undici's requestHook.
 */
export function redactSpreadsheetIdFromSpan(span: Pick<Span, 'setAttribute'>, request: { origin: string; path: string }): void {
  if (request.origin !== SHEETS_ORIGIN || !SPREADSHEET_ID.test(request.path)) return;
  const path = request.path.replace(SPREADSHEET_ID, '$1:id');
  span.setAttribute('url.full', `${SHEETS_ORIGIN}${path}`);
  span.setAttribute('url.path', path.split('?')[0] ?? path);
}
