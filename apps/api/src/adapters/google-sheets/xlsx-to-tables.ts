import { DOMParser } from '@xmldom/xmldom';
import { unzipSync } from 'fflate';

/** One visible worksheet flattened to a rectangular table of display strings. */
export interface WorkbookTable {
  name: string;
  rows: string[][];
  /** Set when the tab was cut short at a cap, so the caller can mark it not importable. */
  overflow?: 'rows' | 'columns';
}

export type XlsxReadErrorCode = 'too-large' | 'malformed';

export class XlsxReadError extends Error {
  constructor(
    readonly code: XlsxReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XlsxReadError';
  }
}

/**
 * Inflated-size caps. The download itself is capped (google-sheet-export.client),
 * but a zip can inflate far past its own size, and each worksheet is built into a
 * DOM several times larger than its XML. So both each part and the whole read are
 * bounded before anything is inflated: a 5,000-row logbook tab is about 2 MB of XML.
 */
export const MAX_XLSX_PART_BYTES = 8 * 1024 * 1024;
export const MAX_XLSX_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_XLSX_PARTS = 300;
/** Widest tab read. Logbook tabs use at most a few dozen columns. */
export const MAX_TABLE_COLUMNS = 100;

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Built-in number-format ids that render as calendar dates (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22]);

const MS_PER_DAY = 86_400_000;

/**
 * Converts every visible worksheet of an XLSX workbook into a string table shaped
 * like a CSV export of that tab (#1111), so the Smart Import classifier and parsers
 * consume it unchanged:
 *
 * - date-formatted numbers → `M/D/YYYY`, the legacy logbook's format read by
 *   `parseDateStringUTC`. Spreadsheet dates are zone-less day serials, so they
 *   are converted with UTC arithmetic and never touch the host time zone. Times
 *   and durations stay numbers.
 * - formula cells → their cached result (the `<v>` Google writes beside `<f>`).
 * - fully empty rows are dropped, trailing empty columns trimmed, and every row
 *   padded to one width — `parseCsvText` rejects ragged rows.
 * - hidden tabs are skipped: they hold helper or backup data, not what the user sees.
 * - a tab is read up to `maxRows` rows and `MAX_TABLE_COLUMNS` columns; past either,
 *   it comes back flagged in `overflow`.
 *
 * Reads only the parts needed for cell values, with a stock zip inflater and DOM
 * parser, rather than a full spreadsheet library. Each worksheet's DOM is built
 * and discarded in turn, so peak memory is the inflated parts plus one DOM.
 */
export function xlsxToTables(buffer: Uint8Array, { maxRows }: { maxRows: number }): WorkbookTable[] {
  let totalBytes = 0;
  let parts = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buffer, {
      filter: (file) => {
        if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(file.name)) {
          return false;
        }
        totalBytes += file.originalSize;
        parts += 1;
        if (file.originalSize > MAX_XLSX_PART_BYTES || totalBytes > MAX_XLSX_TOTAL_BYTES || parts > MAX_XLSX_PARTS) {
          throw new XlsxReadError('too-large', 'The workbook is too large to import.');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof XlsxReadError) throw err;
    throw new XlsxReadError('malformed', 'Not an XLSX workbook');
  }
  const xml = (name: string) => {
    const bytes = files[name];
    return bytes ? parseXml(new TextDecoder().decode(bytes)) : null;
  };

  const workbook = xml('xl/workbook.xml');
  const rels = xml('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new XlsxReadError('malformed', 'Not an XLSX workbook');

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

  return elements(workbook, 'sheet')
    .filter((sheetEl) => {
      const state = sheetEl.getAttribute('state');
      return state !== 'hidden' && state !== 'veryHidden';
    })
    .map((sheetEl) => {
      const name = sheetEl.getAttribute('name') ?? '';
      const path = targets.get(sheetEl.getAttributeNS(REL_NS, 'id') ?? '');
      const sheet = path ? xml(path) : null;
      return sheet ? { name, ...readRows(sheet, { sharedStrings, dateStyles, date1904, maxRows }) } : { name, rows: [] };
    });
}

function readRows(
  sheet: Document,
  ctx: { sharedStrings: string[]; dateStyles: Set<number>; date1904: boolean; maxRows: number },
): Pick<WorkbookTable, 'rows' | 'overflow'> {
  const rows: string[][] = [];
  let overflow: WorkbookTable['overflow'];
  rowLoop: for (const rowEl of elements(sheet, 'row')) {
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of elements(rowEl, 'c')) {
      const ref = c.getAttribute('r');
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      const value = cellValue(c, ctx);
      if (value === '') continue;
      if (col >= MAX_TABLE_COLUMNS) {
        overflow = 'columns';
        break rowLoop;
      }
      cells[col] = value;
    }
    if (cells.length === 0) continue;
    if (rows.length >= ctx.maxRows) {
      overflow = 'rows';
      break;
    }
    rows.push(Array.from(cells, (v) => v ?? ''));
  }

  // The rows read before a cap still go back, so the tab can be classified and named.
  const width = Math.max(0, ...rows.map((row) => row.length));
  const padded = rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  return overflow ? { rows: padded, overflow } : { rows: padded };
}

function cellValue(
  c: Element,
  ctx: { sharedStrings: string[]; dateStyles: Set<number>; date1904: boolean },
): string {
  const type = c.getAttribute('t') ?? 'n';
  if (type === 'inlineStr') return textOf(c).trim();

  const raw = elements(c, 'v')[0]?.textContent ?? '';
  if (raw === '') return '';
  switch (type) {
    case 's':
      return (ctx.sharedStrings[Number(raw)] ?? '').trim();
    case 'str':
      return raw.trim();
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return '';
    default: {
      const n = Number(raw);
      if (!Number.isFinite(n)) return raw.trim();
      if (ctx.dateStyles.has(Number(c.getAttribute('s') ?? '0'))) return serialToDate(n, ctx.date1904);
      // Strip binary floating-point noise (e.g. 172.49999999999997 from a formula).
      return String(Number.parseFloat(n.toPrecision(15)));
    }
  }
}

/** Day serial → `M/D/YYYY`. The 1900 system's epoch is 1899-12-30 for every date after Feb 1900. */
export function serialToDate(serial: number, date1904 = false): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.floor(serial + 1e-9) * MS_PER_DAY);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/**
 * Whether a custom number format shows a calendar date. Quoted literals, escaped
 * characters, `[...]` sections (colors, locales, elapsed `[h]`) and AM/PM markers
 * are dropped first. A day or year token means a date; a bare `m` counts only when
 * it is not a minute, i.e. not next to an hour or second token (`h:mm`, `mm:ss`).
 */
export function isDateFormat(formatCode: string): boolean {
  const code = formatCode.replace(/"[^"]*"|\[[^\]]*\]|\\.|AM\/PM|A\/P/gi, '');
  if (/[dy]/i.test(code)) return true;
  return /m/i.test(code.replace(/h+[^a-z]*m+|m+[^a-z]*s+/gi, ''));
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
    if (isDateFormat(fmt.getAttribute('formatCode') ?? '')) customDate.add(Number(fmt.getAttribute('numFmtId')));
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
  const fail = (msg: string) => {
    throw new XlsxReadError('malformed', msg);
  };
  return new DOMParser({ errorHandler: { error: fail, fatalError: fail } }).parseFromString(text, 'text/xml');
}
