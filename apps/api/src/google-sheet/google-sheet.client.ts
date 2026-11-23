/**
 * Google's OAuth and Sheets endpoints for linking a sheet (#1432, ADR-047). Every failure is a
 * GoogleApiError carrying only `{ status, reason }` (decision 25): never the request, its headers,
 * its body or Google's description, so nothing that reaches a logger can hold a token or code.
 */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const SHEETS_ENDPOINT = 'https://sheets.googleapis.com/v4/spreadsheets';
export const SPREADSHEET_TITLE = 'Lifting Logbook — Supplements';
export const SPREADSHEET_TABS = ['Supplements', 'History'] as const;
// Decision 21: each Google call gets 20 s.
const TIMEOUT_MS = 20_000;

/** Reasons in an API error body, which say why a call failed without its description or request. */
export interface GoogleErrorReasons {
  /** The canonical `error.status`, e.g. `PERMISSION_DENIED` or `NOT_FOUND`. */
  googleStatus?: string;
  /** Each `google.rpc.ErrorInfo` reason in `error.details`, e.g. `SERVICE_DISABLED`. */
  errorInfo?: readonly string[];
  /** Each legacy `error.errors[].reason`, e.g. `rateLimitExceeded`. */
  legacy?: readonly string[];
}

export class GoogleApiError extends Error {
  /**
   * @param reason the one logged: the most specific reason Google gave.
   * @param reasons every reason, for telling a missing sheet from a token or quota problem.
   */
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly reasons: GoogleErrorReasons = {},
  ) {
    super(`Google API error ${status} ${reason}`);
    this.name = 'GoogleApiError';
  }

  toLog(): { status: number; reason: string } {
    return { status: this.status, reason: this.reason };
  }
}

const QUOTA_REASON = /rate_?limit|quota|limitexceeded|resource_exhausted/i;

/**
 * Worth retrying: a timeout or network failure, a 429 or 5xx, or a 403 for a rate or quota reason
 * (decision 12 retries those like a 429).
 */
export function isTransientGoogleError(err: unknown): boolean {
  if (!(err instanceof GoogleApiError)) return false;
  if (err.status === 0 || err.status === 429 || err.status >= 500) return true;
  const { googleStatus, errorInfo = [], legacy = [] } = err.reasons;
  return err.status === 403 && [googleStatus ?? '', ...errorInfo, ...legacy].some((r) => QUOTA_REASON.test(r));
}

/**
 * The lifter deleted the sheet or `drive.file` can no longer reach it (decision 12): a 404 or
 * `NOT_FOUND`, or a 403 `PERMISSION_DENIED` on the spreadsheet itself. A 403 that carries an
 * ErrorInfo reason (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `SERVICE_DISABLED`, `RATE_LIMIT_EXCEEDED`,
 * any quota reason) or a legacy reason other than `forbidden` is about the token, the project or
 * a limit, never the sheet. A bare legacy `forbidden` counts only when it is the only reason.
 */
export function isSheetMissing(err: GoogleApiError): boolean {
  const { googleStatus, errorInfo = [], legacy = [] } = err.reasons;
  if (err.status === 404 || googleStatus === 'NOT_FOUND' || legacy.includes('notFound')) return true;
  if (err.status !== 403 || errorInfo.length > 0 || legacy.some((r) => r !== 'forbidden')) return false;
  return googleStatus === 'PERMISSION_DENIED' || (googleStatus === undefined && legacy.length > 0);
}

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface CodeExchangeResult {
  accessToken: string;
  /** Absent if Google returned none; `prompt=consent` should always get one. */
  refreshToken?: string;
  scope: string;
}

export interface CreatedSpreadsheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
}

export interface IGoogleSheetClient {
  exchangeCode(credentials: OAuthClientCredentials, code: string, codeVerifier: string): Promise<CodeExchangeResult>;
  refreshAccessToken(credentials: OAuthClientCredentials, refreshToken: string): Promise<string>;
  /** Revokes the grant; the token goes in the form body, never the query string (decision 10). */
  revoke(token: string): Promise<void>;
  createSpreadsheet(accessToken: string): Promise<CreatedSpreadsheet>;
  /** False when Google says the sheet is gone or out of the grant's reach (decision 12). */
  canOpenSpreadsheet(accessToken: string, spreadsheetId: string): Promise<boolean>;
}

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

const strings = (values: unknown[]): string[] => values.filter((v): v is string => typeof v === 'string');

/**
 * Google's error reasons, from an OAuth body (`{ error: 'invalid_grant' }`) or an API error body.
 * The logged reason is the most specific: an ErrorInfo reason, then a legacy reason, then the
 * canonical status.
 */
function reasonsOf(body: unknown): { reason: string; reasons: GoogleErrorReasons } {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (typeof error === 'string') return { reason: error, reasons: {} };
  if (!error || typeof error !== 'object') return { reason: 'unknown', reasons: {} };
  const { errors, status, details } = error as { errors?: unknown; status?: unknown; details?: unknown };
  const errorInfo = strings(
    (Array.isArray(details) ? details : [])
      .filter((d) => d && typeof d === 'object' && (d as { '@type'?: unknown })['@type'] === ERROR_INFO_TYPE)
      .map((d) => (d as { reason?: unknown }).reason),
  );
  const legacy = strings((Array.isArray(errors) ? errors : []).map((e) => (e as { reason?: unknown } | null)?.reason));
  const googleStatus = typeof status === 'string' ? status : undefined;
  return {
    reason: errorInfo[0] ?? legacy[0] ?? googleStatus ?? 'unknown',
    reasons: { ...(googleStatus !== undefined && { googleStatus }), errorInfo, legacy },
  };
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new GoogleApiError(0, err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  // A body that isn't JSON reads as reason 'unknown'.
  // fallback-covered-by: apps/api/src/google-sheet/google-sheet.client.spec.ts
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const { reason, reasons } = reasonsOf(body);
    throw new GoogleApiError(res.status, reason, reasons);
  }
  return body as T;
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

export class FetchGoogleSheetClient implements IGoogleSheetClient {
  async exchangeCode(c: OAuthClientCredentials, code: string, codeVerifier: string): Promise<CodeExchangeResult> {
    const body = await call<{ access_token: string; refresh_token?: string; scope?: string }>(
      TOKEN_ENDPOINT,
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: c.redirectUri,
      }),
    );
    return {
      accessToken: body.access_token,
      scope: body.scope ?? '',
      ...(body.refresh_token !== undefined && { refreshToken: body.refresh_token }),
    };
  }

  async refreshAccessToken(c: OAuthClientCredentials, refreshToken: string): Promise<string> {
    const body = await call<{ access_token: string }>(
      TOKEN_ENDPOINT,
      form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret }),
    );
    return body.access_token;
  }

  async revoke(token: string): Promise<void> {
    await call(REVOKE_ENDPOINT, form({ token }));
  }

  async createSpreadsheet(accessToken: string): Promise<CreatedSpreadsheet> {
    const body = await call<CreatedSpreadsheet>(SHEETS_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        properties: { title: SPREADSHEET_TITLE },
        sheets: SPREADSHEET_TABS.map((title) => ({ properties: { title } })),
      }),
    });
    return { spreadsheetId: body.spreadsheetId, spreadsheetUrl: body.spreadsheetUrl };
  }

  async canOpenSpreadsheet(accessToken: string, spreadsheetId: string): Promise<boolean> {
    try {
      await call(`${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return true;
    } catch (err) {
      if (err instanceof GoogleApiError && isSheetMissing(err)) return false;
      throw err;
    }
  }
}
