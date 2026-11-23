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

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Google API error ${status} ${reason}`);
    this.name = 'GoogleApiError';
  }

  toLog(): { status: number; reason: string } {
    return { status: this.status, reason: this.reason };
  }
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

/** Google's error `reason`, from an OAuth (`{ error: 'invalid_grant' }`) or an API error body. */
function reasonOf(body: unknown): string {
  if (!body || typeof body !== 'object') return 'unknown';
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const { errors, status } = error as { errors?: { reason?: unknown }[]; status?: unknown };
    const reason = errors?.[0]?.reason;
    if (typeof reason === 'string') return reason;
    if (typeof status === 'string') return status;
  }
  return 'unknown';
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
  if (!res.ok) throw new GoogleApiError(res.status, reasonOf(body));
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
      // A 403 for a rate or quota reason isn't a missing sheet (decision 12).
      if (err instanceof GoogleApiError && (err.status === 404 || (err.status === 403 && /^(PERMISSION_DENIED|forbidden|notFound)$/.test(err.reason)))) {
        return false;
      }
      throw err;
    }
  }
}
