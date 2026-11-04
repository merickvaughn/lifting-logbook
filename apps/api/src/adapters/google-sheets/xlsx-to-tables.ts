import { DOMParser } from '@xmldom/xmldom';
import { unzipSync } from 'fflate';

/** One worksheet flattened to a rectangular table of display strings. */
export interface WorkbookTable {
  name: string;
  rows: string[][];
}

/**
 * Per-part decompressed-size cap. The download itself is capped (see
 * google-sheet-export.client), but a zip can inflate far past its own size, so
 * each XML part is checked against its declared size before it is inflated.
 */
export const MAX_XLSX_PART_BYTES = 50 * 1024 * 1024;

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Built-in number-format ids that render as dates (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const MS_PER_DAY = 86_400_000;

/**
 * Converts every worksheet of an XLSX workbook into a string table shaped like
 * a CSV export of that tab (#1111), so the Smart Import classifier and parsers
 * consume it unchanged:
 *
 * - date-formatted numbers → `M/D/YYYY`, the legacy logbook's format read by
 *   `parseDateStringUTC`. Spreadsheet dates are zone-less day serials, so they
 *   are converted with UTC arithmetic and never touch the host time zone.
 * - formula cells → their cached result (the `<v>` Google writes beside `<f>`).
 * - fully empty rows are dropped, trailing empty columns trimmed, and every row
 *   padded to one width — `parseCsvText` rejects ragged rows.
 *
 * Reads only the parts needed for cell values, with a stock zip inflater and
 * DOM parser, rather than a full spreadsheet library.
 */
export function xlsxToTables(buffer: Uint8Array): WorkbookTable[] {
  const files = unzipSync(buffer, {
    filter: (file) => {
      if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(file.name)) {
        return false;
      }
      if (file.originalSize > MAX_XLSX_PART_BYTES) {
        throw new Error(`Workbook part ${file.name} is too large`);
      }
      return true;
    },
  });
  const xml = (name: string) => {
    const bytes = files[name];
    return bytes ? parseXml(new TextDecoder().decode(bytes)) : null;
  };

  const workbook = xml('xl/workbook.xml');
  const rels = xml('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('Not an XLSX workbook');

  const targets = new Map<string, string>();
  for (const rel of elements(rels, 'Relationship')) {
    const target = rel.getAttribute('Target') ?? '';
    targets.set(rel.getAttribute('Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const sharedStrings = readSharedStrings(xml('xl/sharedStrings.xml'));
  const dateStyles = readDateStyles(xml('xl/styles.xml'));
  const date1904 = elements(workbook, 'workbookPr').some((el) => {
    const v = el.getAttribute('date1904');
    return v === '1' || v === 'true';
  });

  return elements(workbook, 'sheet').map((sheetEl) => {
    const name = sheetEl.getAttribute('name') ?? '';
    const path = targets.get(sheetEl.getAttributeNS(REL_NS, 'id') ?? '');
    const sheet = path ? xml(path) : null;
    const rows = sheet ? readRows(sheet, sharedStrings, dateStyles, date1904) : [];
    return { name, rows };
  });
}

function readRows(
  sheet: Document,
  sharedStrings: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): string[][] {
  const rows: string[][] = [];
  for (const rowEl of elements(sheet, 'row')) {
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of elements(rowEl, 'c')) {
      const ref = c.getAttribute('r');
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      cells[col] = cellValue(c, sharedStrings, dateStyles, date1904);
    }
    const filled = Array.from(cells, (v) => v ?? '');
    if (filled.some((v) => v !== '')) rows.push(filled);
  }

  let width = 0;
  for (const row of rows) {
    for (let i = row.length - 1; i >= width; i--) {
      if (row[i] !== '') {
        width = i + 1;
        break;
      }
    }
  }
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
}

function cellValue(c: Element, sharedStrings: string[], dateStyles: Set<number>, date1904: boolean): string {
  const type = c.getAttribute('t') ?? 'n';
  if (type === 'inlineStr') return textOf(c).trim();

  const raw = elements(c, 'v')[0]?.textContent ?? '';
  if (raw === '') return '';
  switch (type) {
    case 's':
      return (sharedStrings[Number(raw)] ?? '').trim();
    case 'str':
      return raw.trim();
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return '';
    default: {
      const n = Number(raw);
      if (!Number.isFinite(n)) return raw.trim();
      if (dateStyles.has(Number(c.getAttribute('s') ?? '0'))) return serialToDate(n, date1904);
      // Strip binary floating-point noise (e.g. 172.49999999999997 from a formula).
      return String(Number.parseFloat(n.toPrecision(12)));
    }
  }
}

/** Day serial → `M/D/YYYY`. The 1900 system's epoch is 1899-12-30 for every date after Feb 1900. */
export function serialToDate(serial: number, date1904 = false): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.floor(serial + 1e-9) * MS_PER_DAY);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

function readSharedStrings(doc: Document | null): string[] {
  if (!doc) return [];
  // Phonetic runs (<rPh>) are annotations, not cell text.
  return elements(doc, 'si').map((si) =>
    elements(si, 't')
      .filter((t) => (t.parentNode?.nodeName ?? '').replace(/^.*:/, '') !== 'rPh')
      .map((t) => t.textContent ?? '')
      .join(''),
  );
}

/** Indexes into `cellXfs` whose number format displays as a date. */
function readDateStyles(doc: Document | null): Set<number> {
  const styles = new Set<number>();
  if (!doc) return styles;
  const customDate = new Set<number>();
  for (const fmt of elements(doc, 'numFmt')) {
    // Drop quoted literals and [color]/[locale] sections before looking for date tokens.
    const code = (fmt.getAttribute('formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    if (/[dmy]/i.test(code)) customDate.add(Number(fmt.getAttribute('numFmtId')));
  }
  const cellXfs = elements(doc, 'cellXfs')[0];
  if (!cellXfs) return styles;
  elements(cellXfs, 'xf').forEach((xf, i) => {
    const id = Number(xf.getAttribute('numFmtId') ?? '0');
    if (BUILTIN_DATE_FORMATS.has(id) || customDate.has(id)) styles.add(i);
  });
  return styles;
}

function columnIndex(ref: string): number {
  let col = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    col = col * 26 + (code - 64);
  }
  return col - 1;
}

function textOf(el: Element): string {
  return elements(el, 't').map((t) => t.textContent ?? '').join('');
}

function elements(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', localName));
}

function parseXml(text: string): Document {
  return new DOMParser({
    errorHandler: {
      error: (msg: string) => {
        throw new Error(msg);
      },
      fatalError: (msg: string) => {
        throw new Error(msg);
      },
    },
  }).parseFromString(text, 'text/xml');
}
