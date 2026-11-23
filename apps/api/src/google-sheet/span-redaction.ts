import type { Attributes } from '@opentelemetry/api';

const SHEETS_ORIGIN = 'https://sheets.googleapis.com';
const SPREADSHEET_ID = /(\/spreadsheets\/)[^/?:]+/;

/**
 * The outbound-HTTP span's URL for a Sheets call holds the spreadsheet ID in its path, which
 * ADR-047 decision 24 keeps out of traces (#1432). Wired as instrumentation-undici's
 * startSpanHook, whose attributes replace the instrumentation's own before the span is started,
 * so no span processor or sampler ever sees the ID.
 */
export function redactSpreadsheetIdAttributes(request: { origin: string; path: string }): Attributes {
  if (request.origin !== SHEETS_ORIGIN || !SPREADSHEET_ID.test(request.path)) return {};
  const path = request.path.replace(SPREADSHEET_ID, '$1:id');
  return { 'url.full': `${SHEETS_ORIGIN}${path}`, 'url.path': path.split('?')[0] ?? path };
}
