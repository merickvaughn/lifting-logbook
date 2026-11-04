/**
 * Extracts the spreadsheet ID from a pasted Google Sheets link (#1111).
 *
 * Accepts any `docs.google.com/spreadsheets/d/<id>/...` link — with or without
 * `edit`, `gid`, `usp` or a `#gid=` fragment — or a bare spreadsheet ID. The
 * API builds the export URL from the returned ID alone and never fetches the
 * pasted string, so this is also the server's SSRF boundary: anything that is
 * not a Sheets link on `docs.google.com` is rejected here.
 */

/** Google spreadsheet IDs are URL-safe base64-ish: letters, digits, `-` and `_`. */
const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{20,100}$/;

export type GoogleSheetUrlResult =
  | { ok: true; spreadsheetId: string }
  | { ok: false; message: string };

export function parseGoogleSheetUrl(input: string): GoogleSheetUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, message: 'Paste a Google Sheets link.' };
  }

  if (SPREADSHEET_ID_RE.test(trimmed)) {
    return { ok: true, spreadsheetId: trimmed };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, message: 'That is not a valid link.' };
  }

  if (url.hostname !== 'docs.google.com') {
    return { ok: false, message: 'Only Google Sheets links (docs.google.com) can be imported.' };
  }

  // Path shape: /spreadsheets/d/<id>/... — or /spreadsheets/u/<n>/d/<id>/... when signed into several accounts.
  const id = url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([^/]+)/)?.[1];
  if (!id || !SPREADSHEET_ID_RE.test(id)) {
    return { ok: false, message: 'That link is not a Google Sheets spreadsheet.' };
  }
  return { ok: true, spreadsheetId: id };
}
