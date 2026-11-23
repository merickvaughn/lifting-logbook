import { redactSpreadsheetIdAttributes } from './span-redaction';

describe('redactSpreadsheetIdAttributes (ADR-047, decision 24)', () => {
  const run = (origin: string, path: string) => redactSpreadsheetIdAttributes({ origin, path });

  it("replaces a Sheets call's spreadsheet ID in url.full and url.path", () => {
    expect(run('https://sheets.googleapis.com', '/v4/spreadsheets/1AbcSecretId?fields=spreadsheetId')).toEqual({
      'url.full': 'https://sheets.googleapis.com/v4/spreadsheets/:id?fields=spreadsheetId',
      'url.path': '/v4/spreadsheets/:id',
    });
    expect(JSON.stringify(run('https://sheets.googleapis.com', '/v4/spreadsheets/1AbcSecretId:batchUpdate'))).not.toContain('1AbcSecretId');
  });

  it('leaves other calls alone', () => {
    expect(run('https://sheets.googleapis.com', '/v4/spreadsheets')).toEqual({});
    expect(run('https://example.com', '/v4/spreadsheets/x')).toEqual({});
  });
});
