import { IKeyWrapper } from './token-cipher';
import {
  CodeExchangeResult,
  CreatedSpreadsheet,
  DRIVE_FILE_SCOPE,
  IGoogleSheetClient,
  OAuthClientCredentials,
} from './google-sheet.client';

/** A KMS stand-in: wrapping XORs the key, so a wrapped key is never the key itself. */
export class FakeKeyWrapper implements IKeyWrapper {
  async wrap(dataKey: Buffer): Promise<Buffer> {
    return Buffer.concat([Buffer.from('wrapped:'), dataKey.map((b) => b ^ 0x5a)]);
  }

  async unwrap(wrappedKey: Buffer): Promise<Buffer> {
    return Buffer.from(wrappedKey.subarray('wrapped:'.length).map((b) => b ^ 0x5a));
  }
}

export const FAKE_REFRESH_TOKEN = '1//fake-refresh-token-do-not-log';
export const FAKE_ACCESS_TOKEN = 'ya29.fake-access-token-do-not-log';
export const FAKE_CODE = '4/fake-authorization-code-do-not-log';

type Call = { method: keyof IGoogleSheetClient; args: unknown[] };

/** Records every call. Each method can be replaced per test. */
export class FakeGoogleSheetClient implements IGoogleSheetClient {
  calls: Call[] = [];
  private sheets = 0;
  scope = DRIVE_FILE_SCOPE;
  openable = new Set<string>();

  private record(method: keyof IGoogleSheetClient, args: unknown[]) {
    this.calls.push({ method, args });
  }

  async exchangeCode(c: OAuthClientCredentials, code: string, verifier: string): Promise<CodeExchangeResult> {
    this.record('exchangeCode', [c, code, verifier]);
    return { accessToken: FAKE_ACCESS_TOKEN, refreshToken: FAKE_REFRESH_TOKEN, scope: this.scope };
  }

  async refreshAccessToken(c: OAuthClientCredentials, refreshToken: string): Promise<string> {
    this.record('refreshAccessToken', [c, refreshToken]);
    return FAKE_ACCESS_TOKEN;
  }

  async revoke(token: string): Promise<void> {
    this.record('revoke', [token]);
  }

  async createSpreadsheet(accessToken: string): Promise<CreatedSpreadsheet> {
    this.record('createSpreadsheet', [accessToken]);
    this.sheets += 1;
    const spreadsheetId = `sheet-${this.sheets}`;
    this.openable.add(spreadsheetId);
    return { spreadsheetId, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
  }

  async canOpenSpreadsheet(accessToken: string, spreadsheetId: string): Promise<boolean> {
    this.record('canOpenSpreadsheet', [accessToken, spreadsheetId]);
    return this.openable.has(spreadsheetId);
  }
}

/** Fails the test on any call (decision 22). */
export const failingGoogleClient = (): IGoogleSheetClient => {
  const fail = (method: string) => () => {
    throw new Error(`Google was called (${method}) before the lifter linked a sheet`);
  };
  return {
    exchangeCode: fail('exchangeCode'),
    refreshAccessToken: fail('refreshAccessToken'),
    revoke: fail('revoke'),
    createSpreadsheet: fail('createSpreadsheet'),
    canOpenSpreadsheet: fail('canOpenSpreadsheet'),
  };
};
