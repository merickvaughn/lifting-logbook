#!/usr/bin/env node
/**
 * Converts the 2020–2021 "Lifting_Reference" Google Sheets into lift-record CSV the import
 * wizard reads (#1478). Those workbooks keep one tab per session, named YYYYMMDD, in one of three
 * layouts; the importer only reads one row per set.
 *
 * A one-off tool, not a CI gate. The training data it reads and the CSV it writes stay out of git.
 *
 * Input: one JSON file per workbook, `{ "<tab title>": string[][] }`, the formatted cell values
 * the Sheets API's values.get returns for each tab (trailing blanks trimmed, rows ragged).
 *
 * Usage:
 *   node scripts/convert-lifting-reference.mjs <dump.json>... --out <dir>
 *     Writes <dir>/lifting-reference.csv (split into -1, -2… only past MAX_ROWS_PER_FILE rows)
 *     and <dir>/report.md: what was skipped and why, cells no rule covers, and every lift name.
 *
 * How cells are read (agreed on #1478):
 *   - Only tabs titled YYYYMMDD. Warm-ups are sets, noted `warm-up`.
 *   - A lift with no logged reps is skipped, warm-ups included, and reported.
 *   - `N+` is N reps noted `AMRAP`; `W x R` is that set's weight and reps; N followed by another
 *     marker (`4-I`, `5F`, `10+R`) is N reps with the raw text as the note.
 *   - A weight of `BW (180)` is 180. A cell no rule covers drops that one set and is reported.
 *   - A complex becomes, per completed round, one set of each component at the complex weight,
 *     with the component's planned reps. One with no rounds or no component reps is skipped.
 *
 * The three layouts:
 *   1. Row per lift (May 2020 – Nov 2020): a header row, then
 *      `name, <k plan cells>, warm-up ×5, working weight, set reps…`. The header text is the same
 *      on every tab but the plan columns are not: k is 1 (`4x6`), 2 (sets, reps) or 3 (sets,
 *      range, reps). k is read from the warm-up percentages, else carried from the previous tab.
 *   2. Column per lift (Nov 2020 – Apr 2021): one column per lift, rows in a fixed order (names,
 *      sets, range, reps, warm-up ×5, work sets, set reps…), with an optional `Day` row of dates
 *      above the names. Column A's labels are not trusted: on most 2021 tabs they are shifted a
 *      row down from the data, so rows are found from the names row.
 *   3. 5/3/1 (Jun 2021 – Nov 2021): a Program / Cycle # / Main Lift header, the main lift as
 *      `reps, weight` rows under Warm-up and Work Sets with its logged reps in column B of the
 *      Set rows, Boring But Big as a `5 × 10` row plus `Sets 4 - 8: OK`, and accessories in
 *      columns C onward.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';

// LIFT_RECORD_HEADER_MAP's keys in packages/core/src/constants/schema.ts; a .mjs can't import
// the TypeScript constant.
export const CSV_HEADERS = ['Program', 'Macrocycle #', 'Workout #', 'Date', 'Lift', 'Set #', 'Weight', 'Reps', 'Notes'];
// MAX_IMPORT_ROWS in apps/api/src/programs/import-file.util.ts.
export const MAX_ROWS_PER_FILE = 5000;
// The reps of warm-ups 1–5 in layouts 1 and 2: the headers read "50% x 10" … "110% x 1".
export const WARMUP_REPS = [10, 8, 6, 4, 1];
const WARMUP_PCT = [0.5, 0.65, 0.8, 0.95, 1.1];

const SESSION_TAB = /^(\d{4})(\d{2})(\d{2})$/;

/** Collapses newlines and repeated spaces: "Guil.\nPress" → "Guil. Press". */
export function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** A weight cell → number, or null for blank / N/A / text. `BW (180)` (bodyweight) is 180. */
export function parseWeight(cell) {
  const s = clean(cell);
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const bw = s.match(/^BW \((\d+(?:\.\d+)?)\)$/i);
  return bw ? Number(bw[1]) : null;
}

/**
 * A logged set cell → { reps, weight?, note? }, null when nothing was logged (blank, N/A, OK, -),
 * or { unparsed } for text no rule covers.
 */
export function parseRepCell(cell) {
  const raw = clean(cell);
  if (raw === '' || /^(n\/a|ok|-)$/i.test(raw)) return null;
  let m = raw.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+)(\+)?$/i);
  if (m) {
    const set = { weight: Number(m[1]), reps: Number(m[2]) };
    if (m[3]) set.note = 'AMRAP';
    return set;
  }
  m = raw.match(/^(\d+)(\+)?$/);
  if (m) return m[2] ? { reps: Number(m[1]), note: 'AMRAP' } : { reps: Number(m[1]) };
  // A number then a marker: `4-I`, `5F`, `2FI`, `10+R`, `5++`. Not `1 > 6 > 1` or `-186`.
  m = raw.match(/^(\d+)\s*[A-Za-z+\-.]/);
  if (m) return { reps: Number(m[1]), note: raw };
  return { unparsed: raw };
}

/** "YYYYMMDD" → { year, month, day }, or null. */
export function tabDate(title) {
  const m = SESSION_TAB.exec(title);
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

export function formatDate({ year, month, day }) {
  return `${month}/${day}/${year}`;
}

/** A `Day` cell like "2/23" → a date in the tab's year (the next year if it wraps past December). */
function dayCellDate(cell, tab) {
  const m = clean(cell).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  return { year: month < tab.month - 6 ? tab.year + 1 : tab.year, month, day: Number(m[2]) };
}

const isDayCell = (cell) => /^\d{1,2}\/\d{1,2}$/.test(clean(cell));
const near = (a, b) => a !== null && Math.abs(a - b) <= Math.max(6, b * 0.06);

/**
 * Collects one tab's sets. `lift()` returns an adder for one lift on one date; a lift whose
 * logged sets are all blank is dropped at the end, warm-ups included, and reported.
 */
function newSession(title, date) {
  const lifts = [];
  const result = { records: [], skipped: [], unparsed: [], notes: [] };
  return {
    result,
    skip(lift, reason) {
      result.skipped.push({ tab: title, lift, reason });
    },
    unparsed(lift, cell) {
      result.unparsed.push({ tab: title, lift, cell });
    },
    note(text) {
      if (clean(text)) result.notes.push({ tab: title, text: clean(text) });
    },
    lift(name, { program, onDate } = {}) {
      const entry = { name: clean(name), date: onDate ?? date, program, warmups: [], sets: [], unparsed: false };
      lifts.push(entry);
      return entry;
    },
    finish() {
      for (const l of lifts) {
        if (l.sets.length === 0) {
          if (!l.unparsed) result.skipped.push({ tab: title, lift: l.name, reason: 'no logged reps' });
          continue;
        }
        for (const s of [...l.warmups, ...l.sets]) {
          result.records.push({ program: l.program, date: formatDate(l.date), lift: l.name, weight: s.weight, reps: s.reps, notes: s.notes });
        }
      }
      return result;
    },
  };
}

/** Logs one cell as a set of `lift` at `weight`; returns false if the cell held nothing. */
function addSet(session, lift, cell, weight, extraNote) {
  const set = parseRepCell(cell);
  if (set === null) return false;
  if (set.unparsed !== undefined) {
    session.unparsed(lift.name, set.unparsed);
    lift.unparsed = true;
    return false;
  }
  const w = set.weight ?? weight;
  if (w === null) {
    session.unparsed(lift.name, `${clean(cell)} (no weight)`);
    lift.unparsed = true;
    return false;
  }
  const notes = [extraNote, set.note].filter(Boolean).join('; ') || undefined;
  lift.sets.push({ weight: w, reps: set.reps, notes });
  return true;
}

function addWarmups(lift, weights) {
  weights.forEach((w, i) => {
    if (w !== null) lift.warmups.push({ weight: w, reps: WARMUP_REPS[i], notes: 'warm-up' });
  });
}

/** Expands a complex: `rounds` × one set of each component at `weight`. */
function addComplex(session, name, weight, rounds, components) {
  if (!(rounds > 0)) {
    session.skip(name, 'complex: no completed rounds logged');
    return;
  }
  if (weight === null || components.length === 0 || components.some((c) => c.reps === null)) {
    session.skip(name, 'complex: no weight or no planned reps for its components');
    return;
  }
  for (const c of components) {
    const lift = session.lift(c.name);
    for (let i = 0; i < rounds; i++) lift.sets.push({ weight, reps: c.reps, notes: name });
  }
}

// ── Layout 1: row per lift ──────────────────────────────────────────────────────────────────

/** How many plan cells sit between the name and the warm-ups, read from the warm-up ratios. */
export function inferPlanColumns(rows) {
  const votes = { 1: 0, 2: 0, 3: 0 };
  for (const r of rows.slice(1)) {
    for (const k of [1, 2, 3]) {
      const ww = parseWeight(r[k + 6]);
      if (ww === null || ww === 0) continue;
      if (near(parseWeight(r[k + 1]), ww * WARMUP_PCT[0]) && near(parseWeight(r[k + 5]), ww * WARMUP_PCT[4])) votes[k]++;
    }
  }
  const best = Math.max(...Object.values(votes));
  const winners = Object.keys(votes).filter((k) => votes[k] === best);
  return best > 0 && winners.length === 1 ? Number(winners[0]) : null;
}

export function parseRowPerLift(title, rows, date, k) {
  const s = newSession(title, date);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(r[0]);
    if (!name) continue;
    if (name === 'Notes') {
      rows.slice(i + 1).forEach((n) => s.note(n.join(' ')));
      break;
    }
    const weight = parseWeight(r[k + 6]);
    if (/^Complex/i.test(name)) {
      // Its components are the rows below that stop before the warm-ups (a name and planned reps).
      const components = [];
      let j = i + 1;
      for (; j < rows.length && rows[j].length <= k + 1 && clean(rows[j][0]); j++) {
        const reps = rows[j].slice(1, k + 1).map(parseWeight).find((v) => v !== null && v !== undefined);
        components.push({ name: clean(rows[j][0]), reps: reps ?? null });
      }
      addComplex(s, name, weight, parseWeight(r[k + 7]), components);
      i = j - 1;
      continue;
    }
    const lift = s.lift(name);
    for (let c = k + 7; c < r.length; c++) addSet(s, lift, r[c], weight);
    addWarmups(lift, r.slice(k + 1, k + 6).map(parseWeight));
  }
  return s.finish();
}

// ── Layout 2: column per lift ───────────────────────────────────────────────────────────────

export function parseColumnPerLift(title, rows, date) {
  const s = newSession(title, date);
  // The names row is the first whose cells past column A hold a lift name, not a date or number.
  const namesAt = rows.findIndex((r) => r.slice(1).some((c) => clean(c) && !isDayCell(c) && parseWeight(c) === null));
  const dayRow = namesAt > 0 && rows[namesAt - 1].slice(1).some(isDayCell) ? rows[namesAt - 1] : null;
  const names = rows[namesAt] ?? [];
  const at = (offset, col) => rows[namesAt + offset]?.[col];
  const WORK = 9;
  const FIRST_SET = 10;
  for (let col = 1; col < names.length; col++) {
    const name = clean(names[col]);
    if (!name) continue;
    const weight = parseWeight(at(WORK, col));
    if (/^Complex/i.test(name)) {
      // "Sets Completed" sits in a Set row of this column, with the count below it.
      let rounds = null;
      for (let o = FIRST_SET; namesAt + o < rows.length; o++) {
        if (/sets completed/i.test(clean(at(o, col)))) rounds = parseWeight(at(o + 1, col));
      }
      const components = [];
      for (let c = col + 1; c < names.length && rows.slice(namesAt + 1).every((r) => !clean(r[c])); c++) {
        components.push({ name: clean(names[c]), reps: null });
      }
      addComplex(s, name, weight, rounds, components);
      col += components.length;
      continue;
    }
    const onDate = dayRow ? (dayCellDate(dayRow[col], date) ?? date) : date;
    const lift = s.lift(name, { onDate });
    for (let o = FIRST_SET; namesAt + o < rows.length; o++) addSet(s, lift, at(o, col), weight);
    addWarmups(lift, [4, 5, 6, 7, 8].map((o) => parseWeight(at(o, col))));
  }
  return s.finish();
}

// ── Layout 3: 5/3/1 ─────────────────────────────────────────────────────────────────────────

export function parse531(title, rows, date) {
  const s = newSession(title, date);
  const program = clean(rows[0]?.[1]) || undefined;
  const label = (r) => clean(rows[r]?.[0]);
  const mainName = clean(rows[2]?.[1]) || (label(3) !== 'Exercise' ? label(3) : '');
  const main = s.lift(mainName, { program });
  const accessories = (rows[3] ?? []).slice(2).map((n, i) => ({ col: i + 2, lift: clean(n) ? s.lift(n, { program }) : null }));

  const warmupAt = rows.findIndex((r) => clean(r[0]) === 'Warm-up');
  const workAt = rows.findIndex((r) => clean(r[0]) === 'Work Sets');
  const setRows = [];
  let bbbWeight = null;
  let bbbDone = null;
  for (let r = 0; r < rows.length; r++) {
    const l = label(r);
    if (/^Set \d+$/.test(l)) setRows.push(r);
    else if (/^5 [×x] 10$/.test(l)) bbbWeight = parseWeight(rows[r][1]);
    else if (/^Sets 4 - 8$/.test(l)) bbbDone = clean(rows[r][1]);
  }
  const notesAt = rows.findIndex((r) => clean(r[0]) === 'Notes');

  // Main lift: warm-ups and work sets are `reps, weight` rows; logged reps are in the Set rows.
  const warmupEnd = workAt > warmupAt ? workAt : (setRows[0] ?? notesAt);
  const warmups = warmupAt < 0 ? [] : rows.slice(warmupAt + 1, warmupEnd < 0 ? rows.length : warmupEnd);
  const workRows = workAt < 0 ? [] : rows.slice(workAt + 1).filter((r, i) => workAt + 1 + i < (setRows[0] ?? rows.length) && /^\d+\+?$/.test(clean(r[0])));
  workRows.forEach((w, i) => {
    const logged = setRows[i] === undefined ? undefined : rows[setRows[i]][1];
    addSet(s, main, logged, parseWeight(w[1]), clean(w[0]).endsWith('+') ? 'AMRAP' : undefined);
  });
  if (bbbWeight !== null && /^ok$/i.test(bbbDone ?? '')) {
    for (let i = 0; i < 5; i++) main.sets.push({ weight: bbbWeight, reps: 10, notes: 'BBB' });
  } else if (bbbWeight !== null) {
    s.unparsed(main.name, `5 × 10 at ${bbbWeight}, Sets 4 - 8 = "${bbbDone ?? ''}"`);
  }
  for (const w of warmups) {
    const reps = parseWeight(w[0]);
    const weight = parseWeight(w[1]);
    if (reps !== null && weight !== null) main.warmups.push({ weight, reps, notes: 'warm-up' });
  }

  // Accessories: the weight is on the first Work Sets row, the reps in the Set rows.
  const weightRow = workAt >= 0 ? rows[workAt + 1] ?? [] : [];
  for (const a of accessories) {
    if (!a.lift) continue;
    const weight = parseWeight(weightRow[a.col]);
    for (const r of setRows) addSet(s, a.lift, rows[r][a.col], weight);
  }

  // Anything after the last known row (rows under Notes, stray rows) is reported, not guessed at.
  // A tab with no Set rows (a deload of warm-ups only) logged nothing; its lifts are reported.
  if (setRows.length === 0) return s.finish();
  const lastKnown = Math.max(notesAt, ...setRows, rows.findIndex((r) => /^Sets 4 - 8$/.test(clean(r[0]))));
  if (notesAt >= 0) s.note(rows[notesAt].slice(1).join(' '));
  for (const r of rows.slice(lastKnown + 1)) if (r.some((c) => clean(c))) s.note(`unread row: ${r.map(clean).join(' | ')}`);
  return s.finish();
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────

/** Which layout a tab is in, or null. */
export function detectLayout(rows) {
  const colA = rows.map((r) => clean(r[0]));
  if (colA.includes('Cycle #') && colA.includes('Main Lift')) return 3;
  if (colA[0] === 'Exercise' && (rows[0] ?? []).some((h) => /Working Weight/i.test(clean(h)))) return 1;
  if (colA.includes('Work Sets') && rows.some((r) => r.length > 1)) return 2;
  return null;
}

/**
 * Converts every YYYYMMDD tab of every workbook. A date present in more than one workbook is
 * converted once per copy; identical results are kept once, and differing ones keep the copy with
 * more sets and are reported.
 */
export function convertWorkbooks(workbooks) {
  const report = { tabs: [], skipped: [], unparsed: [], notes: [], unrecognized: [], duplicates: [] };
  const byTitle = new Map();
  for (const wb of workbooks) {
    for (const title of Object.keys(wb.tabs)) {
      if (!tabDate(title)) continue;
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push({ source: wb.name, rows: wb.tabs[title] });
    }
  }
  const records = [];
  let k = null;
  for (const title of [...byTitle.keys()].sort()) {
    const date = tabDate(title);
    const results = byTitle.get(title).map(({ source, rows }) => {
      const layout = detectLayout(rows);
      let result = null;
      let inferredK;
      if (layout === 1) {
        inferredK = inferPlanColumns(rows) ?? k;
        if (inferredK !== null) result = parseRowPerLift(title, rows, date, inferredK);
      } else if (layout === 2) result = parseColumnPerLift(title, rows, date);
      else if (layout === 3) result = parse531(title, rows, date);
      return { source, layout, k: inferredK, result };
    });
    const ok = results.filter((r) => r.result);
    if (ok.length === 0) {
      report.unrecognized.push({ tab: title, sources: results.map((r) => r.source) });
      continue;
    }
    ok.sort((a, b) => b.result.records.length - a.result.records.length);
    const chosen = ok[0];
    if (ok.length > 1) {
      const same = ok.every((r) => JSON.stringify(r.result.records) === JSON.stringify(chosen.result.records));
      report.duplicates.push({ tab: title, kept: chosen.source, sources: ok.map((r) => `${r.source} (${r.result.records.length} sets)`), same });
    }
    if (chosen.layout === 1) k = chosen.k;
    report.tabs.push({ tab: title, source: chosen.source, layout: chosen.layout, k: chosen.k, sets: chosen.result.records.length });
    report.skipped.push(...chosen.result.skipped);
    report.unparsed.push(...chosen.result.unparsed);
    report.notes.push(...chosen.result.notes);
    records.push(...chosen.result.records);
  }
  return { records: numberSets(records), report };
}

/** Numbers sets 1..n per lift per date, in the order they were added (warm-ups first). */
function numberSets(records) {
  const counts = new Map();
  return records.map((r) => {
    const key = `${r.date}|${r.lift}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { ...r, setNum: n };
  });
}

// ── Output ──────────────────────────────────────────────────────────────────────────────────

function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records) {
  const lines = [CSV_HEADERS.join(',')];
  for (const r of records) {
    lines.push([r.program ?? '', '', '', r.date, r.lift, r.setNum, r.weight, r.reps, r.notes ?? ''].map(csvField).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * One file, so the Assign step sees every session at once (a block can run from December into
 * January). Split into parts of at most `max` rows only past the import limit, never inside a date.
 */
export function splitFiles(records, max = MAX_ROWS_PER_FILE) {
  const parts = [[]];
  let i = 0;
  while (i < records.length) {
    let j = i;
    while (j < records.length && records[j].date === records[i].date) j++;
    if (parts.at(-1).length + (j - i) > max && parts.at(-1).length > 0) parts.push([]);
    parts.at(-1).push(...records.slice(i, j));
    i = j;
  }
  return parts.map((p, n) => ({ name: `lifting-reference${parts.length > 1 ? `-${n + 1}` : ''}.csv`, records: p }));
}

export function toReport(records, report, files) {
  const liftCounts = new Map();
  for (const r of records) liftCounts.set(r.lift, (liftCounts.get(r.lift) ?? 0) + 1);
  const md = ['# Lifting_Reference conversion report', ''];
  md.push(`${records.length} sets from ${report.tabs.length} session tabs, in ${files.length} file(s): ${files.map((f) => `${f.name} (${f.records.length})`).join(', ')}.`, '');
  const table = (title, header, rows) => {
    md.push(`## ${title} (${rows.length})`, '');
    if (rows.length === 0) return md.push('None.', '');
    md.push(`| # | ${header.join(' | ')} |`, `|---|${header.map(() => '---').join('|')}|`);
    rows.forEach((r, i) => md.push(`| ${i + 1} | ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`));
    md.push('');
  };
  table('Skipped lifts', ['Tab', 'Lift', 'Reason'], report.skipped.map((s) => [s.tab, s.lift, s.reason]));
  table('Cells no rule covers (that set was left out)', ['Tab', 'Lift', 'Cell'], report.unparsed.map((u) => [u.tab, u.lift, u.cell]));
  table('Unrecognized tabs (not converted)', ['Tab', 'Workbooks'], report.unrecognized.map((u) => [u.tab, u.sources.join(', ')]));
  table('Dates in more than one workbook', ['Tab', 'Copies', 'Kept', 'Same sets'], report.duplicates.map((d) => [d.tab, d.sources.join('; '), d.kept, d.same ? 'yes' : 'no']));
  table('Session notes (not imported)', ['Tab', 'Note'], report.notes.map((n) => [n.tab, n.text]));
  table('Lift names (map unmatched ones in the wizard\'s Review step)', ['Lift', 'Sets'], [...liftCounts].sort((a, b) => a[0].localeCompare(b[0])));
  table('Tabs converted', ['Tab', 'Workbook', 'Layout', 'Plan columns', 'Sets'], report.tabs.map((t) => [t.tab, t.source, t.layout, t.k ?? '', t.sets]));
  return md.join('\n');
}

function main(argv) {
  const outAt = argv.indexOf('--out');
  if (outAt < 0 || !argv[outAt + 1]) {
    console.error('usage: node scripts/convert-lifting-reference.mjs <dump.json>... --out <dir>');
    return 2;
  }
  const out = argv[outAt + 1];
  const inputs = argv.filter((_, i) => i !== outAt && i !== outAt + 1);
  const workbooks = inputs.map((p) => ({ name: p.split(/[\\/]/).pop(), tabs: JSON.parse(readFileSync(p, 'utf8')) }));
  const { records, report } = convertWorkbooks(workbooks);
  const files = splitFiles(records);
  mkdirSync(out, { recursive: true });
  for (const f of files) writeFileSync(join(out, f.name), toCsv(f.records));
  writeFileSync(join(out, 'report.md'), toReport(records, report, files));
  console.log(`${records.length} sets → ${files.map((f) => f.name).join(', ')}; report.md: ${report.skipped.length} skipped lifts, ${report.unparsed.length} unread cells, ${report.unrecognized.length} unrecognized tabs`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
