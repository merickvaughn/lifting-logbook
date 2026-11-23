import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { GoogleSheetLinkStatus, IGoogleSheetLinkRepository } from '../ports/IGoogleSheetLinkRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import {
  AUTHORIZATION_ENDPOINT,
  DRIVE_FILE_SCOPE,
  GoogleApiError,
  IGoogleSheetClient,
  OAuthClientCredentials,
} from './google-sheet.client';
import { TokenCipher } from './token-cipher';

export const GOOGLE_SHEET_CLIENT = Symbol('GOOGLE_SHEET_CLIENT');
export const GOOGLE_TOKEN_CIPHER = Symbol('GOOGLE_TOKEN_CIPHER');

const REQUEST_TTL_MS = 10 * 60_000;
/** Where Unlink sends the lifter when the revoke failed (decision 10). */
export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

export interface GoogleSheetLinkView {
  /** False when the API has no Google client, so Settings hides the Link button (decision 9). */
  configured: boolean;
  status: GoogleSheetLinkStatus | 'unlinked';
  spreadsheetUrl: string | null;
  lastMirroredAt: string | null;
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
 */
@Injectable()
export class GoogleSheetService {
  private readonly logger = new Logger(GoogleSheetService.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    @Inject(GOOGLE_SHEET_CLIENT) private readonly google: IGoogleSheetClient,
    @Inject(GOOGLE_TOKEN_CIPHER) private readonly cipher: TokenCipher,
  ) {}

  private credentials(): OAuthClientCredentials | null {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
  }

  private requireCredentials(): OAuthClientCredentials {
    const credentials = this.credentials();
    if (!credentials) {
      throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'google-sheet-unconfigured', 'Linking a Google Sheet is not set up here.');
    }
    return credentials;
  }

  private async repo(user: AuthUser): Promise<IGoogleSheetLinkRepository> {
    return (await this.factory.forUser(user)).googleSheetLink;
  }

  private googleFailed(operation: string, err: unknown): HttpException {
    this.logger.warn({ operation, ...loggable(err) }, 'Google Sheet link: Google call failed (#1432)');
    return fail(HttpStatus.BAD_GATEWAY, 'google-sheet-google-error', 'Google could not complete the request.');
  }

  async get(user: AuthUser): Promise<GoogleSheetLinkView> {
    const link = await (await this.repo(user)).getLink();
    return {
      configured: this.credentials() !== null,
      status: link?.status ?? 'unlinked',
      spreadsheetUrl: link?.spreadsheetUrl ?? null,
      lastMirroredAt: link?.lastMirroredAt?.toISOString() ?? null,
    };
  }

  async authorize(user: AuthUser): Promise<{ url: string }> {
    const credentials = this.requireCredentials();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    await (await this.repo(user)).putOauthRequest({
      stateHash: sha256(state),
      codeVerifier,
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    });
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
    const repo = await this.repo(user);
    // Taken and deleted in one go: a state is single-use whether or not it matches (decision 5).
    const request = await repo.takeOauthRequest();
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

    // Re-linking keeps a spreadsheet the app can still open (decision 11), and doesn't revoke the
    // old token (decision 13).
    const existing = await repo.getLink();
    let sheet = existing && { spreadsheetId: existing.spreadsheetId, spreadsheetUrl: existing.spreadsheetUrl };
    try {
      if (sheet && !(await this.google.canOpenSpreadsheet(grant.accessToken, sheet.spreadsheetId))) sheet = null;
      sheet ??= await this.google.createSpreadsheet(grant.accessToken);
    } catch (err) {
      throw this.googleFailed('create_spreadsheet', err);
    }

    await repo.saveLink({
      status: 'linked',
      ...sheet,
      grantedScope: grant.scope,
      token: await this.cipher.encrypt(user.id, grant.refreshToken),
    });
    return this.get(user);
  }

  async createSheet(user: AuthUser): Promise<GoogleSheetLinkView> {
    const credentials = this.requireCredentials();
    const repo = await this.repo(user);
    const link = await repo.getLink();
    if (!link) throw fail(HttpStatus.NOT_FOUND, 'google-sheet-not-linked', 'No Google Sheet is linked.');
    if (link.status !== 'sheet_missing' || !link.token) {
      throw fail(HttpStatus.CONFLICT, 'google-sheet-not-missing', 'The linked sheet is not missing.');
    }
    const refreshToken = await this.cipher.decrypt(user.id, link.token);
    let sheet;
    try {
      const accessToken = await this.google.refreshAccessToken(credentials, refreshToken);
      sheet = await this.google.createSpreadsheet(accessToken);
    } catch (err) {
      // invalid_grant: Google access was removed, so the lifter links again (decision 11).
      if (err instanceof GoogleApiError && err.reason === 'invalid_grant') {
        this.logger.error({ operation: 'create_spreadsheet', ...err.toLog() }, 'Google Sheet link: access removed (#1432)');
        await repo.saveLink({ ...link, status: 'needs_relink', token: null });
        throw fail(HttpStatus.CONFLICT, 'google-sheet-needs-relink', 'Google access was removed. Link again.');
      }
      throw this.googleFailed('create_spreadsheet', err);
    }
    await repo.saveLink({ ...link, ...sheet, status: 'linked' });
    return this.get(user);
  }

  async unlink(user: AuthUser): Promise<UnlinkResult> {
    const repo = await this.repo(user);
    const link = await repo.getLink();
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
    await repo.deleteLink();
    return revoked ? { revoked } : { revoked, permissionsUrl: GOOGLE_PERMISSIONS_URL };
  }
}
