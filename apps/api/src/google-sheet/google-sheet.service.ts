import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import {
  EncryptedToken,
  GoogleSheetLinkInput,
  GoogleSheetLinkRecord,
  GoogleSheetLinkStatus,
  IGoogleSheetLinkRepository,
} from '../ports/IGoogleSheetLinkRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import {
  AUTHORIZATION_ENDPOINT,
  CreatedSpreadsheet,
  DRIVE_FILE_SCOPE,
  GoogleApiError,
  IGoogleSheetClient,
  OAuthClientCredentials,
  isTransientGoogleError,
} from './google-sheet.client';
import { TokenCipher } from './token-cipher';

export const GOOGLE_SHEET_CLIENT = Symbol('GOOGLE_SHEET_CLIENT');
export const GOOGLE_TOKEN_CIPHER = Symbol('GOOGLE_TOKEN_CIPHER');

const REQUEST_TTL_MS = 10 * 60_000;
/** Where Unlink sends the lifter when the revoke failed (decision 10). */
export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

export interface GoogleSheetLinkView {
  /** False when the API has no Google client or token key, so Settings hides the Link button (decision 9). */
  configured: boolean;
  status: GoogleSheetLinkStatus | 'unlinked';
  spreadsheetUrl: string | null;
  lastMirroredAt: string | null;
  /** The last mirror run failed for good (decision 21): Settings shows "Last sync failed" with Sync now. */
  syncFailed: boolean;
}

export interface UnlinkResult {
  revoked: boolean;
  /** Set when the revoke failed, so the lifter can remove access there. */
  permissionsUrl?: string;
}

const fail = (status: HttpStatus, error: string, message: string) =>
  new HttpException({ statusCode: status, error, message }, status);

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Google's error as `{ status, reason }`; anything else as its class name only (decision 25). */
const loggable = (err: unknown) =>
  err instanceof GoogleApiError ? err.toLog() : { reason: err instanceof Error ? err.name : 'unknown' };

/**
 * Links, re-links and unlinks a lifter's Google Sheet (#1432, ADR-047 decisions 4-13). Logs carry
 * the operation and Google's `{ status, reason }`, never a token, code, state, verifier, secret or
 * spreadsheet ID (decision 24).
 *
 * Its routes skip the per-request RLS transaction, so each database step runs in its own short
 * transaction (`db`) and commits there, and every Google and KMS call runs between them.
 */
@Injectable()
export class GoogleSheetService {
  private readonly logger = new Logger(GoogleSheetService.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly rls: RlsContextService,
    @Inject(GOOGLE_SHEET_CLIENT) private readonly google: IGoogleSheetClient,
    @Inject(GOOGLE_TOKEN_CIPHER) private readonly cipher: TokenCipher,
  ) {}

  /** Null unless the client, its secret, the redirect URI and the token key are all set. */
  private credentials(): OAuthClientCredentials | null {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const tokenKey = process.env.GOOGLE_OAUTH_TOKEN_KMS_KEY_NAME;
    return clientId && clientSecret && redirectUri && tokenKey ? { clientId, clientSecret, redirectUri } : null;
  }

  private requireCredentials(): OAuthClientCredentials {
    const credentials = this.credentials();
    if (!credentials) {
      throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'google-sheet-unconfigured', 'Linking a Google Sheet is not set up here.');
    }
    return credentials;
  }

  /** Runs `fn` on the user's link in a short RLS transaction of its own, committed when it returns. */
  private db<T>(user: AuthUser, fn: (repo: IGoogleSheetLinkRepository) => Promise<T>): Promise<T> {
    return this.rls.withUserContext(async () => fn((await this.factory.forUser(user)).googleSheetLink));
  }

  private googleFailed(operation: string, err: unknown): HttpException {
    this.logger.warn({ operation, ...loggable(err) }, 'Google Sheet link: Google call failed (#1432)');
    return fail(HttpStatus.BAD_GATEWAY, 'google-sheet-google-error', 'Google could not complete the request.');
  }

  private view(link: GoogleSheetLinkRecord | null): GoogleSheetLinkView {
    return {
      configured: this.credentials() !== null,
      status: link?.status ?? 'unlinked',
      spreadsheetUrl: link?.spreadsheetUrl ?? null,
      lastMirroredAt: link?.lastMirroredAt?.toISOString() ?? null,
      // A code stays on a linked row only once retries ran out or Google rejected the write (decision 21).
      syncFailed: link?.status === 'linked' && link.lastErrorCode !== null,
    };
  }

  /** Saves the link and reads it back in one transaction. */
  private async save(user: AuthUser, link: GoogleSheetLinkInput): Promise<GoogleSheetLinkView> {
    return this.view(
      await this.db(user, async (repo) => {
        await repo.saveLink(link);
        return repo.getLink();
      }),
    );
  }

  async get(user: AuthUser): Promise<GoogleSheetLinkView> {
    return this.view(await this.db(user, (repo) => repo.getLink()));
  }

  async authorize(user: AuthUser): Promise<{ url: string }> {
    const credentials = this.requireCredentials();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    await this.db(user, (repo) =>
      repo.putOauthRequest({ stateHash: sha256(state), codeVerifier, expiresAt: new Date(Date.now() + REQUEST_TTL_MS) }),
    );
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: credentials.redirectUri,
      response_type: 'code',
      scope: DRIVE_FILE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state,
      code_challenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString() };
  }

  async callback(user: AuthUser, code: string, state: string): Promise<GoogleSheetLinkView> {
    const credentials = this.requireCredentials();
    // Taken and deleted in a transaction that commits before anything is checked, so a state is
    // single-use whether or not it matches (decision 5).
    const request = await this.db(user, (repo) => repo.takeOauthRequest());
    const valid =
      request !== null &&
      request.expiresAt.getTime() > Date.now() &&
      request.stateHash.length === 32 &&
      timingSafeEqual(request.stateHash, sha256(state));
    if (!request || !valid) {
      throw fail(HttpStatus.BAD_REQUEST, 'google-sheet-state-invalid', 'This link attempt expired or is not yours. Try again.');
    }

    let grant;
    try {
      grant = await this.google.exchangeCode(credentials, code, request.codeVerifier);
    } catch (err) {
      throw this.googleFailed('exchange', err);
    }
    if (!grant.scope.split(' ').includes(DRIVE_FILE_SCOPE)) {
      throw fail(HttpStatus.FORBIDDEN, 'google-sheet-scope-not-granted', 'Google access to the sheet was not granted.');
    }
    if (!grant.refreshToken) {
      throw this.googleFailed('exchange', new GoogleApiError(200, 'no_refresh_token'));
    }
    // Encrypted before any spreadsheet is created, so a KMS failure leaves nothing in the lifter's Drive.
    const token = await this.cipher.encrypt(user.id, grant.refreshToken);

    // Re-linking keeps a spreadsheet the app can still open (decision 11), and doesn't revoke the
    // old token (decision 13).
    const existing = await this.db(user, (repo) => repo.getLink());
    let sheet: CreatedSpreadsheet;
    try {
      sheet = await this.sheetFor(grant.accessToken, existing);
    } catch (err) {
      throw this.googleFailed('create_spreadsheet', err);
    }
    return this.save(user, { status: 'linked', ...sheet, grantedScope: grant.scope, token, lastErrorCode: null });
  }

  /** The existing spreadsheet unless Google says it's gone, else a new one. */
  private async sheetFor(accessToken: string, existing: GoogleSheetLinkRecord | null): Promise<CreatedSpreadsheet> {
    if (existing) {
      const kept = { spreadsheetId: existing.spreadsheetId, spreadsheetUrl: existing.spreadsheetUrl };
      try {
        if (await this.google.canOpenSpreadsheet(accessToken, existing.spreadsheetId)) return kept;
      } catch (err) {
        // A rate limit or an outage says nothing about the sheet: keep it, and the mirror finds
        // out if it's gone (decision 12), rather than fail the link or replace a good sheet.
        if (!isTransientGoogleError(err)) throw err;
        this.logger.warn({ operation: 'open_spreadsheet', ...loggable(err) }, 'Google Sheet link: kept the sheet on a transient error (#1432)');
        return kept;
      }
    }
    return this.google.createSpreadsheet(accessToken);
  }

  async createSheet(user: AuthUser): Promise<GoogleSheetLinkView> {
    const credentials = this.requireCredentials();
    const link = await this.db(user, (repo) => repo.getLink());
    if (!link) throw fail(HttpStatus.NOT_FOUND, 'google-sheet-not-linked', 'No Google Sheet is linked.');
    if (link.status !== 'sheet_missing' || !link.token) {
      throw fail(HttpStatus.CONFLICT, 'google-sheet-not-missing', 'The linked sheet is not missing.');
    }
    const token: EncryptedToken = link.token;
    const refreshToken = await this.cipher.decrypt(user.id, token);
    let sheet: CreatedSpreadsheet;
    try {
      const accessToken = await this.google.refreshAccessToken(credentials, refreshToken);
      sheet = await this.google.createSpreadsheet(accessToken);
    } catch (err) {
      // invalid_grant: Google access was removed, so the lifter links again (decision 11). Saved
      // in its own transaction, so the 409 doesn't undo it.
      if (err instanceof GoogleApiError && err.reason === 'invalid_grant') {
        this.logger.error({ operation: 'create_spreadsheet', ...err.toLog() }, 'Google Sheet link: access removed (#1432)');
        await this.db(user, (repo) => repo.saveLink({ ...link, status: 'needs_relink', token: null, lastErrorCode: 'invalid_grant' }));
        throw fail(HttpStatus.CONFLICT, 'google-sheet-needs-relink', 'Google access was removed. Link again.');
      }
      throw this.googleFailed('create_spreadsheet', err);
    }
    return this.save(user, { ...link, ...sheet, status: 'linked', token, lastErrorCode: null });
  }

  async unlink(user: AuthUser): Promise<UnlinkResult> {
    const link = await this.db(user, (repo) => repo.getLink());
    let revoked = true;
    if (link?.token) {
      try {
        await this.google.revoke(await this.cipher.decrypt(user.id, link.token));
      } catch (err) {
        revoked = false;
        this.logger.warn({ operation: 'revoke', ...loggable(err) }, 'Google Sheet link: revoke failed (#1432)');
      }
    }
    // Deleted whatever the revoke returned (decision 10).
    await this.db(user, (repo) => repo.deleteLink());
    return revoked ? { revoked } : { revoked, permissionsUrl: GOOGLE_PERMISSIONS_URL };
  }
}
