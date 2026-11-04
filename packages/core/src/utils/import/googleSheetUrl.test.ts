import { parseGoogleSheetUrl } from './googleSheetUrl';

const ID = '15s6_k614x9FzQtHxQDxh82CjDKYqHaS-VZtmS0he-8Q';

describe('parseGoogleSheetUrl', () => {
  it.each([
    [`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1210109955#gid=1210109955`],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit`],
    [`https://docs.google.com/spreadsheets/d/${ID}`],
    [`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit?usp=sharing`],
    [`docs.google.com/spreadsheets/d/${ID}/edit`],
    [`  ${ID}  `],
  ])('extracts the spreadsheet ID from %s', (input) => {
    expect(parseGoogleSheetUrl(input)).toEqual({ ok: true, spreadsheetId: ID });
  });

  it.each([
    [''],
    ['not a url at all'],
    [`https://evil.example.com/spreadsheets/d/${ID}/edit`],
    [`https://docs.google.com.evil.example/spreadsheets/d/${ID}`],
    [`https://docs.google.com/document/d/${ID}/edit`],
    ['https://docs.google.com/spreadsheets/d/tooShort/edit'],
    [`https://docs.google.com/spreadsheets/d/${ID}%2F..%2F/edit`],
    [`${ID}/../../etc`],
  ])('rejects %s', (input) => {
    const result = parseGoogleSheetUrl(input);
    expect(result.ok).toBe(false);
  });
});
