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
 *   - `N+` is N reps noted `AMRAP`; `W x R` is that set's weight and reps (anything after it, like
 *     `185x5F`, goes in the note); N followed directly by a marker (`4-I`, `5F`, `10+R`) is N reps
 *     with the raw text as the note.
 *   - A weight of `BW (180)` is 180. A cell no rule covers drops that one set and is reported.
 *   - A layout 1 complex becomes, per completed round, one set of each component at the complex
 *     weight, with the component's planned reps. One with no rounds or no reps per component is
 *     skipped and reported. Layout 2 sheets never give reps per component, so its complexes are
 *     always skipped and reported.
 *   - Anything a tab can't be read as (a title that isn't a real date, no layout, nothing read) is
 *     listed as an unrecognized tab with the reason, never guessed at.
 *
 * The three layouts:
 *   1. Row per lift (May 2020 – Nov 2020): a header row, then
 *      `name, <k plan cells>, warm-up ×5, working weight, set reps…`. The header text is the same
 *      on every tab but the plan columns are not: k is 1 (`4x6`), 2 (sets, reps) or 3 (sets,
 *      range, reps). k is read from the warm-up percentages, else carried from the previous tab
 *      if it fits this one (`planColumnsFit`); the report marks a carried k.
 *   2. Column per lift (Nov 2020 – Apr 2021): one column per lift, rows in a fixed order (names,
 *      sets, range, reps, warm-up ×5, work sets, set reps…), with an optional `Day` row of dates
 *      above the names. Column A's labels are not trusted: on most 2021 tabs they are shifted a
 *      row down from the data, so rows are found from the names row.
 *   3. 5/3/1 (Jun 2021 – Nov 2021): a Program / Cycle # / Main Lift header, the main lift as
 *      `reps, weight` rows under Warm-up and Work Sets with its logged reps in column B of the
 *      Set rows, Boring But Big as a `5 × 10` row plus `Sets 4 - 8: OK`, and accessories in
 *      columns C onward.
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';

// LIFT_RECORD_HEADER_MAP's keys in packages/core/src/constants/schema.ts; a .mjs can't import
// the TypeScript constant.
export const CSV_HEADERS = ['Program', 'Macrocycle #', 'Workout #', 'Date', 'Lift', 'Set #', 'Weight', 'Reps', 'Notes'];
// MAX_IMPORT_ROWS in apps/api/src/programs/import-file.util.ts.
const MAX_ROWS_PER_FILE = 5000;
// The reps of warm-ups 1–5 in layouts 1 and 2: the headers read "50% x 10" … "110% x 1".
const WARMUP_REPS = [10, 8, 6, 4, 1];
const WARMUP_PCT = [0.5, 0.65, 0.8, 0.95, 1.1];

const SESSION_TAB = /^(\d{4})(\d{2})(\d{2})$/;

/** Collapses newlines and repeated spaces: "Guil.\nPress" → "Guil. Press". */
function clean(value) {
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
  // `W x R`, with anything after it (`+`, `F`, ` (F)`) kept as the note.
  let m = raw.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+)(.*)$/i);
  if (m) {
    const set = { weight: Number(m[1]), reps: Number(m[2]) };
    const rest = m[3].trim();
    if (rest === '+') set.note = 'AMRAP';
    else if (rest) set.note = raw;
    return set;
  }
  m = raw.match(/^(\d+)(\+)?$/);
  if (m) return m[2] ? { reps: Number(m[1]), note: 'AMRAP' } : { reps: Number(m[1]) };
  // A number then a marker right after it: `4-I`, `5F`, `2FI`, `10+R`, `5++`. Not prose
  // (`135 lbs`), a decimal (`8.5`), `1 > 6 > 1` or `-186`.
  m = raw.match(/^(\d+)[A-Za-z+-]/);
  if (m) return { reps: Number(m[1]), note: raw };
  return { unparsed: raw };
}

/** { year, month, day } if that day exists on the calendar, else null. */
function calendarDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null;
}

/** "YYYYMMDD" → { year, month, day }, or null if it isn't a real date. */
function tabDate(title) {
  const m = SESSION_TAB.exec(title);
  return m ? calendarDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

function formatDate({ year, month, day }) {
  return `${month}/${day}/${year}`;
}

/**
 * A `Day` cell like "2/23" → that date in the tab's year, or the year either side when the week
 * crosses New Year (a December cell on a January tab, a January cell on a December tab). Null if it
 * isn't a real date.
 */
function dayCellDate(cell, tab) {
  const m = clean(cell).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = month < tab.month - 6 ? tab.year + 1 : month > tab.month + 6 ? tab.year - 1 : tab.year;
  return calendarDate(year, month, Number(m[2]));
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
  if (weight === null) return session.skip(name, 'complex: no weight');
  if (components.length === 0 || components.some((c) => c.reps === null)) {
    return session.skip(name, 'complex: the sheet has no planned reps for each component');
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

/**
 * Whether a plan-column count carried from an earlier tab fits this one: on every lift row the
 * warm-up cells hold a number, N/A or nothing, and no warm-up is heavier than 120% of the working
 * weight plus 10 (the last is 110%; light lifts round warm-ups up by a plate). A wrong k shifts
 * plan text, weights and reps into each other's columns and fails this. Calibrated on the real
 * dumps (#1478): every tab whose k the warm-ups settle passes with that k.
 */
export function planColumnsFit(rows, k) {
  const numberOrBlank = (cell) => parseWeight(cell) !== null || /^(n\/a)?$/i.test(clean(cell));
  return rows.slice(1).every((r) => {
    const name = clean(r[0]);
    if (!name || name === 'Notes' || /^Complex/i.test(name) || r.length <= k + 1) return true;
    const warmups = r.slice(k + 1, k + 6);
    if (!warmups.every(numberOrBlank)) return false;
    const ww = parseWeight(r[k + 6]);
    return ww === null || warmups.map(parseWeight).every((w) => w === null || w <= ww * 1.2 + 10);
  });
}

function parseRowPerLift(title, rows, date, k) {
  const s = newSession(title, date);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(r[0]);
    if (!name) continue;
    if (name === 'Notes') {
      rows.slice(i).forEach((n, at) => s.note((at === 0 ? n.slice(1) : n).join(' ')));
      break;
    }
    const weight = parseWeight(r[k + 6]);
    if (/^Complex/i.test(name)) {
      // Its components are the rows below that stop before the warm-ups: a name, and the planned
      // reps in the last filled plan cell (the sheets leave Sets blank: `Power Clean, , 5`). The
      // run is all rows with reps, or all rows without; a row of the other kind ends it.
      const components = [];
      const plannedReps = (row) => row.slice(1, k + 1).map(parseWeight).filter((v) => v !== null).at(-1) ?? null;
      let j = i + 1;
      for (; j < rows.length && rows[j].length <= k + 1 && clean(rows[j][0]); j++) {
        const reps = plannedReps(rows[j]);
        if (components.length > 0 && (reps === null) !== (components[0].reps === null)) break;
        components.push({ name: clean(rows[j][0]), reps });
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

function parseColumnPerLift(title, rows, date) {
  const s = newSession(title, date);
  // The names row is the first whose cells past column A hold a lift name, not a date or number.
  const namesAt = rows.findIndex((r) => r.slice(1).some((c) => clean(c) && !isDayCell(c) && parseWeight(c) === null));
  if (namesAt < 0) return null;
  const dayRow = namesAt > 0 && rows[namesAt - 1].slice(1).some(isDayCell) ? rows[namesAt - 1] : null;
  const names = rows[namesAt];
  const at = (offset, col) => rows[namesAt + offset]?.[col];
  const WORK = 9;
  const FIRST_SET = 10;
  // Set rows end at Notes. Column A may sit a row below the data (`Exercise` beside the row after
  // the names), so the Notes label then marks the row after the first notes row.
  const shift = clean(rows[namesAt][0]) !== 'Exercise' && clean(rows[namesAt + 1]?.[0]) === 'Exercise' ? 1 : 0;
  const notesLabel = rows.findIndex((r, i) => i > namesAt && clean(r[0]) === 'Notes');
  const end = notesLabel < 0 ? rows.length : Math.max(namesAt + FIRST_SET, notesLabel - shift);
  rows.slice(end).forEach((r) => s.note(r.slice(1).join(' ')));
  for (let col = 1; col < names.length; col++) {
    const name = clean(names[col]);
    if (!name) continue;
    const weight = parseWeight(at(WORK, col));
    if (/^Complex/i.test(name)) {
      // The component columns to its right are empty below their names: the sheet has no planned
      // reps per component, so a complex in this layout is never expanded, only reported.
      let rounds = null;
      for (let o = FIRST_SET; namesAt + o < end; o++) {
        if (/sets completed/i.test(clean(at(o, col)))) rounds = parseWeight(at(o + 1, col));
      }
      let c = col + 1;
      while (c < names.length && rows.slice(namesAt + 1).every((r) => !clean(r[c]))) c++;
      s.skip(name, rounds > 0 ? `complex: ${rounds} rounds logged, but the sheet has no planned reps for each component` : 'complex: no completed rounds logged');
      col = c - 1;
      continue;
    }
    let onDate = date;
    if (dayRow && clean(dayRow[col])) {
      onDate = dayCellDate(dayRow[col], date);
      if (!onDate) {
        s.unparsed(name, `Day "${clean(dayRow[col])}" (not a date; lift left out)`);
        continue;
      }
    }
    const lift = s.lift(name, { onDate });
    for (let o = FIRST_SET; namesAt + o < end; o++) addSet(s, lift, at(o, col), weight);
    addWarmups(lift, [4, 5, 6, 7, 8].map((o) => parseWeight(at(o, col))));
  }
  return s.finish();
}

// ── Layout 3: 5/3/1 ─────────────────────────────────────────────────────────────────────────

function parse531(title, rows, date) {
  const s = newSession(title, date);
  const program = clean(rows[0]?.[1]) || undefined;
  const label = (r) => clean(rows[r]?.[0]);
  const mainName = clean(rows[2]?.[1]) || (label(3) !== 'Exercise' ? label(3) : '');
  // With no Main Lift name its sets can't be imported: they are collected, then reported.
  const main = mainName ? s.lift(mainName, { program }) : { name: '(no Main Lift name)', warmups: [], sets: [] };
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
  // Reps logged in a Set row with no work set above to give their weight.
  setRows.slice(workRows.length).forEach((r) => {
    if (clean(rows[r][1])) s.unparsed(main.name, `${label(r)}: ${clean(rows[r][1])} (no work set for it)`);
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
  if (!mainName && main.sets.length + main.warmups.length > 0) {
    s.skip(main.name, `${main.sets.length} sets and ${main.warmups.length} warm-ups left out`);
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
      if (!SESSION_TAB.test(title)) continue;
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push({ source: wb.name, rows: wb.tabs[title] });
    }
  }
  const records = [];
  let k = null;
  for (const title of [...byTitle.keys()].sort()) {
    const date = tabDate(title);
    const results = byTitle.get(title).map(({ source, rows }) => {
      const out = { source, layout: date ? detectLayout(rows) : null, k: undefined, result: null, reason: null };
      if (!date) out.reason = 'the title is not a real date';
      else if (out.layout === null) out.reason = 'no layout matches';
      else if (out.layout === 1) {
        const inferred = inferPlanColumns(rows);
        if (inferred !== null) out.k = inferred;
        else if (k === null) out.reason = 'layout 1, plan columns unknown';
        else if (!planColumnsFit(rows, k)) out.reason = `layout 1, the ${k} plan columns carried from the tab before don't fit`;
        else out.k = `${k} (carried)`;
        if (out.k !== undefined) out.result = parseRowPerLift(title, rows, date, parseInt(out.k, 10));
      } else if (out.layout === 2) {
        out.result = parseColumnPerLift(title, rows, date);
        if (!out.result) out.reason = 'layout 2, no lift names row';
      } else out.result = parse531(title, rows, date);
      // A tab that read nothing at all, not even a lift to skip, was not understood.
      const r = out.result;
      if (r && r.records.length + r.skipped.length + r.unparsed.length === 0) {
        out.result = null;
        out.reason = `layout ${out.layout}, nothing read`;
      }
      return out;
    });
    const ok = results.filter((r) => r.result);
    if (ok.length === 0) {
      report.unrecognized.push({ tab: title, sources: results.map((r) => r.source), reason: [...new Set(results.map((r) => r.reason))].join('; ') });
      continue;
    }
    ok.sort((a, b) => b.result.records.length - a.result.records.length);
    const chosen = ok[0];
    if (ok.length > 1) {
      const same = ok.every((r) => JSON.stringify(r.result.records) === JSON.stringify(chosen.result.records));
      report.duplicates.push({ tab: title, kept: chosen.source, sources: ok.map((r) => `${r.source} (${r.result.records.length} sets)`), same });
    }
    if (chosen.layout === 1) k = parseInt(chosen.k, 10);
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
  // A date's records need not be next to each other (a Day row can date columns 2/23, 2/25, 2/23),
  // so gather each date's records first, in order of first appearance.
  const byDate = new Map();
  for (const r of records) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const parts = [[]];
  for (const group of byDate.values()) {
    if (parts.at(-1).length + group.length > max && parts.at(-1).length > 0) parts.push([]);
    parts.at(-1).push(...group);
  }
  return parts.map((p, n) => ({ name: `lifting-reference${parts.length > 1 ? `-${n + 1}` : ''}.csv`, records: p }));
}

function toReport(records, report, files) {
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
  table('Unrecognized tabs (not converted)', ['Tab', 'Workbooks', 'Reason'], report.unrecognized.map((u) => [u.tab, u.sources.join(', '), u.reason]));
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
  // Parts left by an earlier run would be uploaded alongside this one's and import twice.
  for (const old of readdirSync(out)) if (/^lifting-reference(-\d+)?\.csv$/.test(old)) unlinkSync(join(out, old));
  for (const f of files) writeFileSync(join(out, f.name), toCsv(f.records));
  writeFileSync(join(out, 'report.md'), toReport(records, report, files));
  console.log(`${records.length} sets → ${files.map((f) => f.name).join(', ')}; report.md: ${report.skipped.length} skipped lifts, ${report.unparsed.length} unread cells, ${report.unrecognized.length} unrecognized tabs`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
