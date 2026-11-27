import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

import {
  CSV_HEADERS,
  convertWorkbooks,
  detectLayout,
  inferPlanColumns,
  parseRepCell,
  parseWeight,
  splitFiles,
  toCsv,
} from './convert-lifting-reference.mjs';

// Synthetic tabs shaped like the real Lifting_Reference sheets (#1478). No real training data.
const L1_HEADER = [
  'Exercise', 'Sets', 'Rep Range', 'Reps',
  'Warm-up 1 (50% x 10)', 'Warm-up 2 (65% x 8)', 'Warm-up 3 (80% x 6)', 'Warm-up 4 (95% x 4)', 'Warm-up 5 (110% x 1)',
  'Working Weight', 'Set 1', 'Set 2', 'Set 3',
];

const convert = (tabs) => convertWorkbooks([{ name: 'wb.json', tabs }]);
// A complex set ends with its complex and round (#1494); any other set with its note.
const sets = (records, lift) =>
  records
    .filter((r) => r.lift === lift)
    .map((r) => (r.complex ? [r.setNum, r.weight, r.reps, r.complex, r.complexRound] : [r.setNum, r.weight, r.reps, r.notes ?? '']));

test('parseRepCell reads the notations in the sheets', () => {
  assert.deepEqual(parseRepCell('8'), { reps: 8 });
  assert.deepEqual(parseRepCell('0'), { reps: 0 });
  assert.deepEqual(parseRepCell('7+'), { reps: 7, note: 'AMRAP' });
  assert.deepEqual(parseRepCell('135 x 9'), { weight: 135, reps: 9 });
  assert.deepEqual(parseRepCell('4-I'), { reps: 4, note: '4-I' });
  assert.deepEqual(parseRepCell('2FI'), { reps: 2, note: '2FI' });
  assert.deepEqual(parseRepCell('10+R'), { reps: 10, note: '10+R' });
  for (const nothing of ['', ' ', 'N/A', 'OK', '-']) assert.equal(parseRepCell(nothing), null, nothing);
  for (const unknown of ['inj.', '-186', '1 > 6 > 1', 'E']) assert.deepEqual(parseRepCell(unknown), { unparsed: unknown });
});

test('parseRepCell never reads a weight, prose or a decimal as reps', () => {
  // An annotated override keeps its weight and reps, with the raw text as the note.
  assert.deepEqual(parseRepCell('185x5F'), { weight: 185, reps: 5, note: '185x5F' });
  assert.deepEqual(parseRepCell('135 x 5 (F)'), { weight: 135, reps: 5, note: '135 x 5 (F)' });
  assert.deepEqual(parseRepCell('135 x 5+'), { weight: 135, reps: 5, note: 'AMRAP' });
  for (const prose of ['135 lbs', '135lbs', '45s', '8-10', '3 sets, felt heavy', '8.5', '5 F', '3x10, 2x8', '5x5 felt easy', '185x5f', '135x5 reg', '100x3 fig', '135 x 5 (F']) {
    assert.deepEqual(parseRepCell(prose), { unparsed: prose });
  }
});

test('parseWeight reads numbers and BW (n), and nothing else', () => {
  assert.equal(parseWeight('17.5'), 17.5);
  assert.equal(parseWeight('BW (180)'), 180);
  for (const none of ['', 'N/A', 'BW', ':180']) assert.equal(parseWeight(none), null, none);
});

test('detectLayout tells the three layouts apart', () => {
  assert.equal(detectLayout([L1_HEADER, ['Squat']]), 1);
  assert.equal(detectLayout([['Exercise', 'Deadlift'], ['Sets', '3'], ['Work Sets', '225']]), 2);
  assert.equal(detectLayout([['Program', '5/3/1'], ['Cycle #', '1'], ['Main Lift', 'Squat'], ['Work Sets']]), 3);
  assert.equal(detectLayout([['numSheetsToSort', '10']]), null);
});

test('layout 1: warm-ups, overrides, AMRAP and the plan-column count', () => {
  // k = 3 plan cells (sets, range, reps); warm-ups are 50–110% of the 150 working weight.
  const rows = [
    L1_HEADER,
    ['Guillotine Press', '3', '8 - 10', '10', '75', '100', '120', '145', '165', '150', '7+', '135 x 9', '4-I'],
    ['Barbell Curl', '3', '10', '10', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', '75', '10'],
    ['Pull-up', '3', '4 - 6', '5', '100', '130', '160', '190', '220', '200'],
  ];
  assert.equal(inferPlanColumns(rows), 3);
  const { records, report } = convert({ 20200723: rows });
  assert.deepEqual(sets(records, 'Guillotine Press'), [
    [1, 75, 10, 'warm-up'], [2, 100, 8, 'warm-up'], [3, 120, 6, 'warm-up'], [4, 145, 4, 'warm-up'], [5, 165, 1, 'warm-up'],
    [6, 150, 7, 'AMRAP'], [7, 135, 9, ''], [8, 150, 4, '4-I'],
  ]);
  assert.deepEqual(sets(records, 'Barbell Curl'), [[1, 75, 10, '']]);
  assert.equal(records[0].date, '7/23/2020');
  // Pull-up has a plan but no logged reps: skipped with its warm-ups, and reported.
  assert.deepEqual(sets(records, 'Pull-up'), []);
  assert.deepEqual(report.skipped, [{ tab: '20200723', lift: 'Pull-up', reason: 'no logged reps' }]);
});

test('layout 1: the plan-column count carries forward when warm-ups cannot settle it', () => {
  const early = [L1_HEADER, ['Squat', '4x6', '130', '170', '205', '245', '285', '255', '6']];
  // Only blank warm-ups, so the ratios give no answer; k = 1 comes from the tab before.
  const next = [L1_HEADER, ['Wrist Roller', '4x3', '', '', '', '', '', '45', '3', '3']];
  assert.equal(inferPlanColumns(next), null);
  const { records, report } = convert({ 20200509: early, 20200510: next });
  assert.deepEqual(sets(records, 'Wrist Roller'), [[1, 45, 3, ''], [2, 45, 3, '']]);
  assert.deepEqual(report.tabs.map((t) => [t.k, t.carried]), [[1, false], [1, true]]);
});

test('layout 1: a carried count is refused when the plan cells show another (light lifts, blank warm-ups)', () => {
  // k = 2 settled here; the next tab is k = 1 (`3x15` plans), which the warm-up weights alone
  // can't rule out for light and bodyweight lifts.
  const before = [L1_HEADER, ['Curl', '3', '10', '35', '45', '55', '65', '75', '70', '10']];
  const next = [
    L1_HEADER,
    ['Band Pull-apart', '3x15', '', '', '', '', '', '10', '15', '15', '15'],
    ['Pull-up', '3x8', '', '', '', '', '', '', '8', '8', '7'],
  ];
  const { records, report } = convert({ 20200601: before, 20200602: next });
  assert.equal(records.filter((r) => r.date === '6/2/2020').length, 0);
  assert.equal(report.unrecognized[0].reason, "layout 1, the 2 plan columns carried from the tab before don't fit");
});

test('layout 1: a carried plan-column count that does not fit the tab is reported, not used', () => {
  const before = [L1_HEADER, ['Curl', '3', '10', '10', '35', '45', '55', '65', '75', '70', '10']];
  // k = 1 with blank warm-ups; read with the carried k = 3, 75 would become a warm-up of a 10 lb lift.
  const next = [L1_HEADER, ['Curl', '4x10', '', '', '', '', '', '75', '10', '10', '9', '8']];
  const { records, report } = convert({ 20200601: before, 20200602: next });
  assert.equal(records.filter((r) => r.date === '6/2/2020').length, 0);
  assert.deepEqual(report.unrecognized, [
    { tab: '20200602', sources: ['wb.json'], reason: "layout 1, the 3 plan columns carried from the tab before don't fit" },
  ]);
});

test('layout 1: text beside the Notes label is kept as a note', () => {
  const rows = [L1_HEADER, ['Curl', '3', '10', '10', '35', '45', '55', '65', '75', '70', '10'], ['Notes', 'Felt strong'], ['Grip gave out']];
  const { records, report } = convert({ 20200601: rows });
  assert.equal(records.length, 6);
  assert.deepEqual(report.notes.map((n) => n.text), ['Felt strong', 'Grip gave out']);
});

test('layout 1: a complex becomes rounds × components; one without rounds is reported', () => {
  const header = L1_HEADER.slice(0, 10).concat('Sets Completed');
  const done = [
    header,
    ['Complex 1A', '4', '', '', '', '', '', '', '', '65', '2'],
    ['Power Clean', '', '5'],
    ['Push Press', '', '8'],
  ];
  const notDone = [header, ['Complex 1A', '4', '', '', '', '', '', '', '', '65'], ['Power Clean', '', '5']];
  // A complex row has no warm-ups to read k from; it comes from the session before.
  const before = [L1_HEADER, ['Curl', '3', '10', '10', '35', '45', '55', '65', '75', '70', '10']];
  const { records, report } = convert({ 20201005: before, 20201006: done, 20201007: notDone });
  assert.deepEqual(sets(records, 'Power Clean'), [[1, 65, 5, 'Complex 1A', 1], [2, 65, 5, 'Complex 1A', 2]]);
  assert.deepEqual(sets(records, 'Push Press'), [[1, 65, 8, 'Complex 1A', 1], [2, 65, 8, 'Complex 1A', 2]]);
  assert.deepEqual(report.skipped, [{ tab: '20201007', lift: 'Complex 1A', reason: 'complex: no completed rounds logged' }]);
});

test('layout 1: with two plan cells a component takes its reps, not its sets', () => {
  // k = 2 (sets, reps), settled by the warm-ups of the tab before.
  const before = [L1_HEADER, ['Curl', '3', '10', '35', '45', '55', '65', '75', '70', '10']];
  // The header text is the same whatever k is; only the data rows lose a plan column.
  const header = L1_HEADER.slice(0, 10).concat('Sets Completed');
  // Component rows leave Sets blank; a row with Sets filled is an unlogged lift, not a component.
  const done = [
    header,
    ['Complex 1A', '4', '', '', '', '', '', '', '65', '2'],
    ['Power Clean', '', '5'],
    ['Pull-up', '3'],
    ['Notes', 'felt good'],
  ];
  const { records, report } = convert({ 20201005: before, 20201006: done });
  assert.deepEqual(sets(records, 'Power Clean'), [[1, 65, 5, 'Complex 1A', 1], [2, 65, 5, 'Complex 1A', 2]]);
  assert.deepEqual(sets(records, 'Pull-up'), []);
  assert.deepEqual(report.skipped, [{ tab: '20201006', lift: 'Pull-up', reason: 'no logged reps' }]);
  assert.deepEqual(report.notes.map((n) => n.text), ['felt good']);
});

test('layout 1: a complex just before Notes stops at the Notes row', () => {
  // k = 1, settled by the warm-ups on this tab.
  const done = [
    L1_HEADER,
    ['Curl', '3x10', '35', '45', '55', '65', '75', '70', '10'],
    ['Complex A', '', '', '', '', '', '', '65', '3'],
    ['Power Clean', '5'],
    // With one plan column an unlogged lift has a `3x10` plan; a component has only its reps.
    ['Pull-up', '3x10'],
    ['Notes', 'felt good'],
    ['second note line'],
  ];
  const { records, report } = convert({ 20201006: done });
  assert.equal(sets(records, 'Power Clean').length, 3);
  assert.deepEqual(report.skipped, [{ tab: '20201006', lift: 'Pull-up', reason: 'no logged reps' }]);
  assert.deepEqual(report.notes.map((n) => n.text), ['felt good', 'second note line']);
});

test('layout 1: a complex with any component lacking reps is skipped whole, never part-imported', () => {
  const before = [L1_HEADER, ['Curl', '3', '10', '35', '45', '55', '65', '75', '70', '10']];
  const header = L1_HEADER.slice(0, 10).concat('Sets Completed');
  const done = [
    header,
    ['Complex 1A', '4', '', '', '', '', '', '', '65', '3'],
    ['Power Clean', '', '5'],
    ['Front Squat'],
    ['Push Press', '', '5'],
  ];
  const { records, report } = convert({ 20201005: before, 20201006: done });
  assert.equal(records.filter((r) => r.date === '10/6/2020').length, 0);
  assert.deepEqual(report.skipped, [
    { tab: '20201006', lift: 'Complex 1A', reason: 'complex: 3 rounds logged, but the sheet has no planned reps for Front Squat' },
  ]);
});

test('layout 1: a multi-line Rep Range merged over the components gives each group its reps (#1482)', () => {
  const before = [L1_HEADER, ['Curl', '3', '8 - 12', '10', '50', '65', '80', '95', '110', '100', '10']];
  const header = L1_HEADER.slice(0, 10).concat('Sets Completed');
  const parts = ['Bent-Over Barbell Row', 'Power Clean', 'Front Squat', 'Push Press', 'Back Squat', 'Good Morning'];
  const complex = (repRange) => [
    header,
    ['Complex 1A', '3 - 5\n\n5 - 7', repRange, '3\n\n-', '', '', '', '45', '75', '105', '2'],
    ...parts.map((p) => [p]),
  ];
  const { records, report } = convert({ 20201024: before, 20201025: complex('3\n\n8') });
  for (const [i, p] of parts.entries()) {
    const reps = i < 3 ? 3 : 8;
    assert.deepEqual(sets(records, p), [[1, 105, reps, 'Complex 1A', 1], [2, 105, reps, 'Complex 1A', 2]], p);
  }
  assert.deepEqual(report.skipped, []);

  // Lines that don't split the components evenly, or aren't reps, are reported, not guessed at.
  for (const [bad, shown] of [['3\n\n8\n\n5\n\n2', '3 / 8 / 5 / 2'], ['3\n\n-', '3 / -']]) {
    const out = convert({ 20201024: before, 20201025: complex(bad) });
    assert.equal(out.records.filter((r) => r.date === '10/25/2020').length, 0, shown);
    assert.deepEqual(out.report.skipped, [{
      tab: '20201025',
      lift: 'Complex 1A',
      reason: `complex: 2 rounds logged, but the Rep Range lines (${shown}) are not whole reps that split its 6 components evenly`,
    }], shown);
  }
});

test('a lift whose every logged cell is unread is listed as skipped, as well as its cells', () => {
  const rows = [L1_HEADER, ['Squat', '3', '5', '5', '100', '130', '160', '190', '220', '200', 'lots', 'more']];
  const { records, report } = convert({ 20200601: rows });
  assert.equal(records.length, 0);
  assert.deepEqual(report.skipped.map((s) => s.reason), ['no readable reps (see the cells no rule covers); warm-ups left out too']);
  assert.deepEqual(report.unparsed.map((u) => u.cell), ['lots', 'more']);
});

// Layout 2 rows in their fixed order below the names row.
const l2Body = (cols) => [
  ['Sets', ...cols.map((c) => c.sets)],
  ['Rep Range', ...cols.map(() => '4 - 6')],
  ['Reps', ...cols.map(() => '5')],
  ['W1: 50% x 10', ...cols.map((c) => c.w[0])],
  ['W2: 65% x 8', ...cols.map((c) => c.w[1])],
  ['W3: 80% x 6', ...cols.map((c) => c.w[2])],
  ['W4: 95% x 4', ...cols.map((c) => c.w[3])],
  ['W5: 110% x 1', ...cols.map((c) => c.w[4])],
  ['Work Sets', ...cols.map((c) => c.work)],
  ['Set 1', ...cols.map((c) => c.reps[0] ?? '')],
  ['Set 2', ...cols.map((c) => c.reps[1] ?? '')],
];
const DL = { sets: '3', w: ['115', '150', '185', '220', '255'], work: '230', reps: ['5', '7'] };
const OHP = { sets: '3', w: ['50', '65', '80', '95', '110'], work: '100', reps: ['6', '5'] };

test('layout 2: a Day row dates each column', () => {
  const rows = [['Day', '2/23', '2/25'], ['Exercise', 'Deadlift', 'Overhead \nPress'], ...l2Body([DL, OHP])];
  const { records } = convert({ 20210216: rows });
  assert.deepEqual([...new Set(records.map((r) => `${r.date} ${r.lift}`))], ['2/23/2021 Deadlift', '2/25/2021 Overhead Press']);
  assert.deepEqual(sets(records, 'Deadlift').slice(4), [[5, 255, 1, 'warm-up'], [6, 230, 5, ''], [7, 230, 7, '']]);
});

test('layout 2: a Day row across New Year dates each side in its own year; a non-date is reported', () => {
  const dates = (tab, day) => {
    const { records, report } = convert({ [tab]: [['Day', ...day], ['Exercise', 'Deadlift', 'Overhead Press'], ...l2Body([DL, OHP])] });
    return { dates: [...new Set(records.map((r) => `${r.date} ${r.lift}`))], report };
  };
  assert.deepEqual(dates('20210104', ['12/30', '1/4']).dates, ['12/30/2020 Deadlift', '1/4/2021 Overhead Press']);
  assert.deepEqual(dates('20201228', ['12/28', '1/2']).dates, ['12/28/2020 Deadlift', '1/2/2021 Overhead Press']);
  const bad = dates('20210216', ['2/30', '2/25']);
  assert.deepEqual(bad.dates, ['2/25/2021 Overhead Press']);
  assert.deepEqual(bad.report.unparsed, [{ tab: '20210216', lift: 'Deadlift', cell: 'Day "2/30" (not a date; lift left out)' }]);
});

test('layout 2: rows from Notes on are notes, not sets, whether or not column A is shifted', () => {
  const aligned = [['Exercise', 'Deadlift'], ...l2Body([DL]), ['Notes', '2 plates felt easy']];
  const labels = aligned.map((r) => r[0]);
  const shifted = aligned.map((r, i) => [i === 0 ? 'Day' : labels[i - 1], ...r.slice(1)]).concat([['Notes']]);
  for (const rows of [aligned, shifted]) {
    const { records, report } = convert({ 20201208: rows });
    assert.equal(records.length, 7);
    assert.deepEqual(report.notes.map((n) => n.text), ['2 plates felt easy']);
  }
});

test('layout 2: column A shifted a row down from the data reads the same as an aligned tab', () => {
  const aligned = [['Exercise', 'Deadlift'], ...l2Body([DL])];
  // The 2021 workbook's copies: a Day label pushed only column A down a row.
  const labels = aligned.map((r) => r[0]);
  const shifted = aligned.map((r, i) => [i === 0 ? 'Day' : labels[i - 1], ...r.slice(1)]);
  const a = convertWorkbooks([{ name: 'a', tabs: { 20201208: aligned } }]).records;
  const b = convertWorkbooks([{ name: 'b', tabs: { 20201208: shifted } }]).records;
  assert.equal(a.length, 7); // 5 warm-ups and 2 sets
  assert.deepEqual(b, a);
});

test('a copy of a date that could not be read is listed even though the other copy was converted', () => {
  const { records, report } = convertWorkbooks([
    { name: '2020.json', tabs: { 20201208: [['Exercise', 'Deadlift'], ...l2Body([DL])] } },
    { name: '2021.json', tabs: { 20201208: [['Something', 'else']] } },
  ]);
  assert.equal(records.length, 7);
  assert.deepEqual(report.unrecognized, [
    { tab: '20201208', sources: ['2021.json'], reason: 'no layout matches; the copy in 2020.json was converted', otherCopyConverted: true },
  ]);
});

test('a lift that two tabs put on one date is listed', () => {
  const tab = (day) => [['Day', day], ['Exercise', 'Deadlift'], ...l2Body([DL])];
  const { report } = convert({ 20210222: tab('2/23'), 20210223: tab('2/23') });
  assert.deepEqual(report.overlaps, [{ date: '2/23/2021', lift: 'Deadlift', tabs: ['20210222', '20210223'] }]);
});

test('a date in two workbooks is converted once, and reported', () => {
  const tab = [['Exercise', 'Deadlift'], ...l2Body([DL])];
  const { records, report } = convertWorkbooks([
    { name: '2020.json', tabs: { 20201208: tab } },
    { name: '2021.json', tabs: { 20201208: tab } },
  ]);
  assert.equal(records.length, 7);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].same, true);
});

test('layout 2: a complex with no rounds is reported, and its components are not lifts', () => {
  const rows = [
    ['Exercise', 'Cable Crunch', 'Complex 1A', 'Power Clean'],
    ['Sets', '3', '3 - 5'],
    ['Rep Range', '10 - 12', '3 | 8'],
    ['Reps', '10', '3'],
    ['W1: 50% x 10', '30', 'N/A'], ['W2: 65% x 8'], ['W3: 80% x 6'], ['W4: 95% x 4', '', '55'], ['W5: 110% x 1', '', '85'],
    ['Work Sets', '55', '110'],
    ['Set 1', '10', 'Sets Completed'],
    ['Set 2', '11', '0'],
  ];
  const { records, report } = convert({ 20201129: rows });
  assert.deepEqual(sets(records, 'Cable Crunch'), [[1, 30, 10, 'warm-up'], [2, 55, 10, ''], [3, 55, 11, '']]);
  assert.deepEqual(report.skipped, [{ tab: '20201129', lift: 'Complex 1A', reason: 'complex: no completed rounds logged (components: Power Clean)' }]);
  // With rounds logged it is still reported, since the sheet has no reps per component.
  rows[11] = ['Set 2', '11', '3'];
  assert.deepEqual(convert({ 20201129: rows }).report.skipped, [
    { tab: '20201129', lift: 'Complex 1A', reason: 'complex: 3 rounds logged, but the sheet has no planned reps for its components (Power Clean)' },
  ]);
  // A note under a component column doesn't turn it into a lift.
  const noted = [...rows, ['Notes', '', '', 'grip slipped']];
  assert.deepEqual(convert({ 20201129: noted }).report.skipped.map((s) => s.lift), ['Complex 1A']);
});

test('layout 3 (5/3/1): warm-ups, work sets, BBB, accessories and stray rows', () => {
  const rows = [
    ['1', '5/3/1 BBB', 'Start\nDate', '11/15/2021'],
    ['Cycle #', '1', 'Week #', '1'],
    ['Main Lift', '', 'Max', '185'],
    ['Bench Press', '', 'Cable Rows', 'Chin-up'],
    ['Sets', 'N/A', '3', '3'],
    ['Reps', '5', '12', '12'],
    ['Warm-up'], ['5', '75', 'N/A'], ['5', '95'], ['5', '110'],
    ['Work Sets'], ['5', '120', '55', 'BW (180)'], ['5', '140'], ['5+', '155'],
    ['5 × 10', '75'],
    ['Set 1', '5', '12', '10'], ['Set 2', '5', '12', 'inj.'], ['Set 3', '8', '', ''],
    ['Sets 4 - 8', 'OK', 'N/A', 'N/A'],
    ['Notes', 'Felt good.'],
    ['135', '5'],
  ];
  const { records, report } = convert({ 20211123: rows });
  assert.deepEqual(sets(records, 'Bench Press'), [
    [1, 75, 5, 'warm-up'], [2, 95, 5, 'warm-up'], [3, 110, 5, 'warm-up'],
    [4, 120, 5, ''], [5, 140, 5, ''], [6, 155, 8, 'AMRAP'],
    [7, 75, 10, 'BBB'], [8, 75, 10, 'BBB'], [9, 75, 10, 'BBB'], [10, 75, 10, 'BBB'], [11, 75, 10, 'BBB'],
  ]);
  assert.deepEqual(sets(records, 'Cable Rows'), [[1, 55, 12, ''], [2, 55, 12, '']]);
  assert.deepEqual(sets(records, 'Chin-up'), [[1, 180, 10, '']]);
  assert.equal(records[0].program, '5/3/1 BBB');
  assert.deepEqual(report.unparsed, [
    { tab: '20211123', lift: 'Chin-up', cell: 'inj.' },
    { tab: '20211123', lift: '(row after the Set rows)', cell: '135 | 5' },
  ]);
  assert.deepEqual(report.notes.map((n) => n.text), ['Felt good.']);
});

test('layout 3: Boring But Big rows that are not one weight and one OK are reported', () => {
  const tab = (...bbb) => [
    ['Program', '5/3/1 BBB'], ['Cycle #', '1'], ['Main Lift', 'Squat'], ['Exercise', '', 'Curl'],
    ['Work Sets'], ['5', '200', '30'], ...bbb, ['Set 1', '5', '10'],
  ];
  const unread = (...bbb) => convert({ 20211101: tab(...bbb) }).report.unparsed.map((u) => [u.lift, u.cell]);
  const bbbSets = (...bbb) => sets(convert({ 20211101: tab(...bbb) }).records, 'Squat').filter((s) => s[3] === 'BBB').length;
  assert.deepEqual(unread(['5 × 10', ''], ['Sets 4 - 8', 'ok']), [['Squat', '5 × 10 at "", Sets 4 - 8 = "ok"']]);
  assert.deepEqual(unread(['5 × 10', 'BW'], ['Sets 4 - 8', 'ok']), [['Squat', '5 × 10 at "BW", Sets 4 - 8 = "ok"']]);
  assert.deepEqual(unread(['Sets 4 - 8', 'ok']), [['Squat', '5 × 10 at "", Sets 4 - 8 = "ok"']]);
  // A plain 5/3/1 tab with N/A in both rows logged nothing.
  assert.deepEqual(unread(['5 × 10', 'N/A', 'N/A'], ['Sets 4 - 8', 'N/A', '-']), []);
  // Cells past column B are reported; the BBB sets still import.
  assert.equal(bbbSets(['5 × 10', '135', '12'], ['Sets 4 - 8', 'ok']), 5);
  assert.deepEqual(unread(['5 × 10', '135', '12'], ['Sets 4 - 8', 'ok']), [['(Boring But Big row)', '5 × 10 | 135 | 12']]);
  // Two pairs: none imported, all four rows reported.
  const two = [['5 × 10', '135'], ['Sets 4 - 8', 'ok'], ['5 × 10', '95'], ['Sets 4 - 8', 'no']];
  assert.equal(bbbSets(...two), 0);
  assert.equal(unread(...two).length, 4);
});

test('layout 3: a deload of warm-ups only logs nothing and reports its lifts', () => {
  const rows = [
    ['Program', '5/3/1'], ['Cycle #', '1', 'Week #', 'Deload'], ['Main Lift', 'Bench Press', 'Max', '190'],
    ['Exercise', '', 'Cable Rows'], ['Sets', 'N/A', '3'], ['Reps', 'N/A', '12'],
    ['Warm-up'], ['5', '95'], ['3', '135', '55'], ['1', '175'],
  ];
  const { records, report } = convert({ 20211109: rows });
  assert.equal(records.length, 0);
  assert.deepEqual(report.skipped.map((s) => s.lift), ['Bench Press', 'Cable Rows']);
  assert.deepEqual(report.notes, []);
});

test('layout 3: extra logged main-lift reps and a missing Main Lift name are reported', () => {
  const tab = (main) => [
    ['Program', '5/3/1'], ['Cycle #', '1'], ['Main Lift', main], ['Exercise', '', 'Curl'],
    ['Work Sets'], ['5', '200', '30'], ['Set 1', '5', '10'], ['Set 2', '6', '10'],
  ];
  // A row between the Set rows and Notes is reported too.
  const stray = convert({ 20211101: [...tab('Squat'), ['Extra', '', '12'], ['Notes', 'ok day']] });
  assert.deepEqual(stray.report.unparsed.at(-1), { tab: '20211101', lift: '(row after the Set rows)', cell: 'Extra |  | 12' });
  assert.deepEqual(stray.report.notes.map((n) => n.text), ['ok day']);
  const named = convert({ 20211101: tab('Squat') });
  assert.deepEqual(sets(named.records, 'Squat'), [[1, 200, 5, '']]);
  assert.deepEqual(named.report.unparsed, [{ tab: '20211101', lift: 'Squat', cell: 'Set 2: 6 (no work set for it)' }]);
  const unnamed = convert({ 20211101: tab('') });
  assert.deepEqual([...new Set(unnamed.records.map((r) => r.lift))], ['Curl']);
  assert.deepEqual(unnamed.report.skipped, [{ tab: '20211101', lift: '(no Main Lift name)', reason: '1 sets and 0 warm-ups left out' }]);
});

test('an unrecognized tab is reported with its reason, never guessed at; non-session tabs are ignored', () => {
  const { records, report } = convert({
    20200101: [['Something', 'else']],
    20201340: [['Exercise', 'Deadlift'], ...l2Body([DL])],
    20210105: [['Day', '1/1'], ['Exercise'], ['Work Sets', '5']],
    20210106: [['Cycle #', '1'], ['Main Lift', '']],
    Session_Template: [L1_HEADER],
  });
  assert.equal(records.length, 0);
  assert.deepEqual(report.unrecognized.map((u) => [u.tab, u.reason]), [
    ['20200101', 'no layout matches'],
    ['20201340', 'the title is not a real date'],
    ['20210105', 'layout 2, no lift names row'],
    ['20210106', 'layout 3, nothing read'],
  ]);
});

test('toCsv writes the lift-record headers and quotes fields that need it', () => {
  const csv = toCsv([{ program: '5/3/1', date: '1/2/2021', lift: 'Squat', setNum: 1, weight: 100, reps: 5, notes: 'a, "b"' }]);
  assert.equal(csv, `${CSV_HEADERS.join(',')}\n5/3/1,,,1/2/2021,Squat,1,100,5,"a, ""b""",,\n`);
});

test('toCsv writes a complex set\'s complex and round, which the app\'s importer reads (#1494)', () => {
  const csv = toCsv([{ date: '10/6/2020', lift: 'Power Clean', setNum: 1, weight: 65, reps: 5, complex: 'Complex 1A', complexRound: 2 }]);
  assert.deepEqual(CSV_HEADERS.slice(-2), ['Complex', 'Round']);
  assert.equal(csv.split('\n')[1], ',,,10/6/2020,Power Clean,1,65,5,,Complex 1A,2');
});

test('splitFiles keeps one file under the limit, and past it never splits a date', () => {
  const rec = (date) => ({ date, lift: 'Squat' });
  const rows = [rec('12/30/2020'), rec('12/30/2020'), rec('1/2/2021'), rec('1/3/2021'), rec('1/4/2021')];
  assert.deepEqual(splitFiles(rows, 5).map((f) => [f.name, f.records.length]), [['lifting-reference.csv', 5]]);
  // With a limit of 2, 12/30's two rows stay together.
  assert.deepEqual(splitFiles(rows, 2).map((f) => [f.name, f.records.length]), [
    ['lifting-reference-1.csv', 2],
    ['lifting-reference-2.csv', 2],
    ['lifting-reference-3.csv', 1],
  ]);
  // A date that comes back after another (a Day row dating columns 2/23, 2/25, 2/23) stays whole.
  const interleaved = [rec('2/23/2021'), rec('2/25/2021'), rec('2/23/2021')];
  assert.deepEqual(splitFiles(interleaved, 2).map((f) => f.records.map((r) => r.date)), [
    ['2/23/2021', '2/23/2021'],
    ['2/25/2021'],
  ]);
});

test('the CLI writes CSV and a report, replacing parts from an earlier run', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lifting-reference-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dump = join(dir, 'wb.json');
  writeFileSync(dump, JSON.stringify({ 20201208: [['Exercise', 'Deadlift'], ...l2Body([DL])] }));
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'out', 'lifting-reference-2.csv'), 'stale');
  const script = fileURLToPath(new URL('./convert-lifting-reference.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, dump, '--out', join(dir, 'out')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(dir, 'out', 'lifting-reference-2.csv')), false);
  assert.match(run.stdout, /removed lifting-reference-2\.csv from an earlier run/);
  const csv = readFileSync(join(dir, 'out', 'lifting-reference.csv'), 'utf8');
  assert.equal(csv.trim().split('\n').length, 8); // header + 7 sets
  assert.match(readFileSync(join(dir, 'out', 'report.md'), 'utf8'), /7 sets from 1 session tabs/);
  assert.equal(spawnSync(process.execPath, [script, dump], { encoding: 'utf8' }).status, 2);
});
