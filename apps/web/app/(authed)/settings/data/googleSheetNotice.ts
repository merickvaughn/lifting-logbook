/**
 * What the callback route (#1433) tells Settings > Data about a link attempt, as a `?google_sheet=`
 * value. It's a fixed code, never anything Google sent, so it's safe to put in a URL and to show.
 */
export const GOOGLE_SHEET_NOTICES = {
  linked: 'Your Google Sheet is linked.',
  denied: 'Google access wasn’t granted, so nothing was linked.',
  scope: 'Google access to the sheet wasn’t granted. Link again and allow access to files this app creates.',
  expired: 'That link attempt expired or isn’t yours. Link again.',
  signin: 'Your session ended before linking finished. Sign in again, then link again.',
  failed: 'Google couldn’t finish linking your sheet. Try again in a moment.',
} as const;

export type GoogleSheetNoticeCode = keyof typeof GOOGLE_SHEET_NOTICES;

export const GOOGLE_SHEET_NOTICE_PARAM = 'google_sheet';

export function isGoogleSheetNotice(value: unknown): value is GoogleSheetNoticeCode {
  return typeof value === 'string' && Object.hasOwn(GOOGLE_SHEET_NOTICES, value);
}

/** The API's own error name for a failed call: its Nest exceptions carry it as `error`, not `code`. */
export function googleSheetErrorName(err: unknown): string | undefined {
  const name = (err as { body?: { error?: unknown } } | null)?.body?.error;
  return typeof name === 'string' ? name : undefined;
}
