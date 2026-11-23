import { IKeyWrapper } from './token-cipher';
import {
  CodeExchangeResult,
  CreatedSpreadsheet,
  DRIVE_FILE_SCOPE,
  IGoogleSheetClient,
  OAuthClientCredentials,
  SheetsRequest,
  SpreadsheetTab,
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

/** The first exchange's refresh token; each later one appends `-<n>`, so it contains this one. */
export const FAKE_REFRESH_TOKEN = '1//fake-refresh-token-do-not-log';
export const FAKE_ACCESS_TOKEN = 'ya29.fake-access-token-do-not-log';
export const FAKE_CODE = '4/fake-authorization-code-do-not-log';

type Call = { method: keyof IGoogleSheetClient; args: unknown[] };

/** Fails the test on any call (decision 22). */
export const failingKeyWrapper = (): IKeyWrapper => {
  const fail = (method: string) => () => {
    throw new Error(`KMS was called (${method}) before the lifter linked a sheet`);
  };
  return { wrap: fail('wrap'), unwrap: fail('unwrap') };
};

/** Records every call. Each method can be replaced per test. */
export class FakeGoogleSheetClient implements IGoogleSheetClient {
  calls: Call[] = [];
  private sheets = 0;
  private exchanges = 0;
  scope = DRIVE_FILE_SCOPE;
  openable = new Set<string>();
  /** The tabs `listTabs` reports. */
  tabs: SpreadsheetTab[] = [];
  /** Every successful `batchUpdate`'s requests, in order. */
  batches: SheetsRequest[][] = [];
  /** Set to make the next `batchUpdate`, or `refreshAccessToken`, throw it once. */
  failNextBatch?: unknown;
  failNextRefresh?: unknown;
  /** Runs just before a `batchUpdate` is applied, e.g. to change the stack while a run writes. */
  beforeBatch?: () => Promise<void>;
  /** Runs just before a `refreshAccessToken` answers, e.g. to unlink while a run is under way. */
  beforeRefresh?: () => Promise<void>;

  private record(method: keyof IGoogleSheetClient, args: unknown[]) {
    this.calls.push({ method, args });
  }

  async exchangeCode(c: OAuthClientCredentials, code: string, verifier: string): Promise<CodeExchangeResult> {
    this.record('exchangeCode', [c, code, verifier]);
    this.exchanges += 1;
    return { accessToken: FAKE_ACCESS_TOKEN, refreshToken: FakeGoogleSheetClient.refreshToken(this.exchanges), scope: this.scope };
  }

  /** The refresh token the `n`th exchange returns. */
  static refreshToken(n: number): string {
    return n === 1 ? FAKE_REFRESH_TOKEN : `${FAKE_REFRESH_TOKEN}-${n}`;
  }

  async refreshAccessToken(c: OAuthClientCredentials, refreshToken: string): Promise<string> {
    this.record('refreshAccessToken', [c, refreshToken]);
    await this.beforeRefresh?.();
    if (this.failNextRefresh) {
      const err = this.failNextRefresh;
      this.failNextRefresh = undefined;
      throw err;
    }
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

  async listTabs(accessToken: string, spreadsheetId: string): Promise<SpreadsheetTab[]> {
    this.record('listTabs', [accessToken, spreadsheetId]);
    return this.tabs;
  }

  async batchUpdate(accessToken: string, spreadsheetId: string, requests: SheetsRequest[]): Promise<void> {
    this.record('batchUpdate', [accessToken, spreadsheetId, requests]);
    await this.beforeBatch?.();
    if (this.failNextBatch) {
      const err = this.failNextBatch;
      this.failNextBatch = undefined;
      throw err;
    }
    this.batches.push(requests);
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
    listTabs: fail('listTabs'),
    batchUpdate: fail('batchUpdate'),
  };
};
