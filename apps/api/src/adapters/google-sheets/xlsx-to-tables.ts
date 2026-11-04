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
 * Reads only the parts needed for cell values, rather than a full spreadsheet
 * library. The small parts (workbook, relationships, styles) go through a DOM
 * parser; worksheets and shared strings, the parts that grow with the data, are
 * scanned row by row and cell by cell without building a DOM, so memory stays
 * close to the inflated XML itself and a tab stops being read at the row cap.
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
  const text = (name: string) => {
    const bytes = files[name];
    return bytes ? new TextDecoder().decode(bytes) : null;
  };
  const xml = (name: string) => {
    const source = text(name);
    return source === null ? null : parseXml(source);
  };

  const workbook = xml('xl/workbook.xml');
  const rels = xml('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new XlsxReadError('malformed', 'Not an XLSX workbook');

  const targets = new Map<string, string>();
  for (const rel of elements(rels, 'Relationship')) {
    const target = rel.getAttribute('Target') ?? '';
    targets.set(rel.getAttribute('Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const sharedStrings = readSharedStrings(text('xl/sharedStrings.xml'));
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
      const sheet = path ? text(path) : null;
      return sheet ? { name, ...readRows(sheet, { sharedStrings, dateStyles, date1904, maxRows }) } : { name, rows: [] };
    });
}

/** Longest start tag read. Real SpreadsheetML start tags are a few dozen characters. */
const MAX_TAG_LENGTH = 2048;

interface ScannedElement {
  attrs: string;
  body: string;
  start: number;
  end: number;
}

const isTagNameEnd = (ch: string | undefined) =>
  ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/**
 * Yields each `<name …>…</name>` or `<name …/>` element of `source` in order,
 * with or without a namespace prefix. Used for the data-sized parts (worksheets
 * and shared strings) instead of a DOM.
 *
 * Forward-only: every search starts where the previous one ended, so a scan is
 * linear in the input even when the input is malformed, and a missing `>` or
 * closing tag throws rather than being searched for again from each later
 * opening tag (which made the earlier regex scanner quadratic). SpreadsheetML
 * rows, cells, shared strings and text runs never nest inside themselves, and
 * text cannot contain a raw `<`, so the first matching closing tag ends the element.
 * Not handled, because Google's export never writes them: single-quoted attributes,
 * CDATA sections and XML comments.
 */
function* scan(source: string, name: string): Generator<ScannedElement> {
  let pos = 0;
  for (;;) {
    const hit = source.indexOf(name, pos);
    if (hit < 0) return;
    pos = hit + name.length;
    if (!isTagNameEnd(source[pos])) continue;
    // The name must open a tag: right after `<`, or after `<prefix:`.
    let open = hit - 1;
    let prefix = '';
    if (source[open] === ':') {
      let p = open - 1;
      while (p > hit - 64 && /\w/.test(source[p] ?? '')) p--;
      if (source[p] !== '<' || p === open - 1) continue;
      prefix = source.slice(p + 1, open + 1);
      open = p;
    }
    if (source[open] !== '<') continue;

    const tagEnd = source.indexOf('>', pos);
    if (tagEnd < 0 || tagEnd - open > MAX_TAG_LENGTH) throw new XlsxReadError('malformed', `Unterminated <${name}> tag`);
    if (source[tagEnd - 1] === '/') {
      yield { attrs: source.slice(pos, tagEnd - 1), body: '', start: open, end: tagEnd + 1 };
      pos = tagEnd + 1;
      continue;
    }
    const closeTag = `</${prefix}${name}>`;
    const close = source.indexOf(closeTag, tagEnd + 1);
    if (close < 0) throw new XlsxReadError('malformed', `Unclosed <${name}> element`);
    yield { attrs: source.slice(pos, tagEnd), body: source.slice(tagEnd + 1, close), start: open, end: close + closeTag.length };
    pos = close + closeTag.length;
  }
}

/** `source` with every `name` element cut out. */
function withoutElements(source: string, name: string): string {
  let kept = '';
  let from = 0;
  for (const el of scan(source, name)) {
    kept += source.slice(from, el.start);
    from = el.end;
  }
  return kept + source.slice(from);
}

// Applied only to one start tag's attribute text, which scan() caps at MAX_TAG_LENGTH.
const ATTR_RE = /([\w:]+)="([^"]*)"/g;

function attributes(source: string): Map<string, string> {
  return new Map(Array.from(source.matchAll(ATTR_RE), (m) => [m[1] ?? '', decodeXml(m[2] ?? '')]));
}

function texts(source: string): string {
  return Array.from(scan(source, 't'), (t) => decodeXml(t.body)).join('');
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(source: string): string {
  return source.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()] ?? '';
    const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function readRows(
  sheet: string,
  ctx: { sharedStrings: string[]; dateStyles: Set<number>; date1904: boolean; maxRows: number },
): Pick<WorkbookTable, 'rows' | 'overflow'> {
  const rows: string[][] = [];
  let overflow: WorkbookTable['overflow'];
  rowLoop: for (const row of scan(sheet, 'row')) {
    const cells: string[] = [];
    let nextCol = 0;
    for (const cell of scan(row.body, 'c')) {
      const attrs = attributes(cell.attrs);
      const ref = attrs.get('r');
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      const value = cellValue(attrs, cell.body, ctx);
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
  attrs: Map<string, string>,
  body: string,
  ctx: { sharedStrings: string[]; dateStyles: Set<number>; date1904: boolean },
): string {
  const type = attrs.get('t') ?? 'n';
  if (type === 'inlineStr') return texts(withoutElements(body, 'rPh')).trim();

  const raw = decodeXml(scan(body, 'v').next().value?.body ?? '');
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
      if (ctx.dateStyles.has(Number(attrs.get('s') ?? '0'))) return serialToDate(n, ctx.date1904);
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

function readSharedStrings(source: string | null): string[] {
  if (source === null) return [];
  // Phonetic runs (<rPh>) are annotations, not cell text.
  return Array.from(scan(source, 'si'), (si) => texts(withoutElements(si.body, 'rPh')));
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

function elements(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', localName));
}

function parseXml(text: string): Document {
  const fail = (msg: string) => {
    throw new XlsxReadError('malformed', msg);
  };
  return new DOMParser({ errorHandler: { error: fail, fatalError: fail } }).parseFromString(text, 'text/xml');
}
