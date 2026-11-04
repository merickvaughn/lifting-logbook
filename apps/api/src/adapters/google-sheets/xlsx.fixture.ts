import { strToU8, zipSync } from 'fflate';

/**
 * Test-only builder for minimal XLSX workbooks (#1111), shaped like Google
 * Sheets' export: shared strings, a date style, and cached formula results.
 */
export type FixtureCell =
  | string
  | number
  | null
  | { date: number }
  | { formula: string; result: number }
  /** A `<c>` element's attributes and inner XML, for cell types the shorthands don't cover. */
  | { attrs: string; inner: string };

export interface FixtureSheet {
  name: string;
  rows: FixtureCell[][];
  state?: 'hidden' | 'veryHidden';
}

export interface FixtureOptions {
  date1904?: boolean;
  /** Extra custom number formats; `s="2"`, `s="3"`, … refer to them in order. */
  numFmts?: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel day serial for a calendar date (1900 date system). */
export function dateSerial(year: number, month: number, day: number): number {
  return (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

export function buildXlsx(sheets: FixtureSheet[], options: FixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const strings: string[] = [];
  const stringIndex = (s: string) => {
    const at = strings.indexOf(s);
    if (at >= 0) return at;
    strings.push(s);
    return strings.length - 1;
  };

  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, si) => {
    const rows = sheet.rows
      .map((row, ri) => {
        const cells = row
          .map((cell, ci) => {
            const r = `${colName(ci)}${ri + 1}`;
            if (cell === null) return '';
            if (typeof cell === 'string') return `<c r="${r}" t="s"><v>${stringIndex(cell)}</v></c>`;
            if (typeof cell === 'number') return `<c r="${r}"><v>${cell}</v></c>`;
            if ('date' in cell) return `<c r="${r}" s="1"><v>${cell.date}</v></c>`;
            if ('attrs' in cell) return `<c r="${r}" ${cell.attrs}>${cell.inner}</c>`;
            return `<c r="${r}"><f>${esc(cell.formula)}</f><v>${cell.result}</v></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    );
  });

  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${
      options.date1904 ? '<workbookPr date1904="1"/>' : ''
    }<sheets>${sheets
      .map(
        (s, i) =>
          `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`,
      )
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings
      .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
      .join('')}</sst>`,
  );
  const formats = ['M/d/yyyy', ...(options.numFmts ?? [])];
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${formats.length}">${formats
      .map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(code)}"/>`)
      .join('')}</numFmts><cellXfs count="${formats.length + 1}"><xf numFmtId="0"/>${formats
      .map((_, i) => `<xf numFmtId="${164 + i}" applyNumberFormat="1"/>`)
      .join('')}</cellXfs></styleSheet>`,
  );
  return zipFixture(files);
}

/** `zipSync`, copied into a plain `ArrayBuffer`-backed array so it types as a fetch `Response` body. */
export function zipFixture(files: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(zipSync(files));
}
