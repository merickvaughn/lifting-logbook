import { strToU8, zipSync } from 'fflate';
import {
  MAX_TABLE_COLUMNS,
  MAX_XLSX_PART_BYTES,
  XlsxReadError,
  isDateFormat,
  serialToDate,
  xlsxToTables,
} from './xlsx-to-tables';
import { buildXlsx, dateSerial } from './xlsx.fixture';

const read = (buffer: Uint8Array, maxRows = 100) => xlsxToTables(buffer, { maxRows });

describe('xlsxToTables', () => {
  it('flattens each worksheet to a rectangular string table', () => {
    const tables = read(
      buildXlsx([
        {
          name: 'LIFT_RECORDS',
          rows: [
            ['Program', 'Cycle #', 'Workout #', 'Date', 'Lift', 'Set #', 'Weight', 'Reps', 'Notes'],
            ['RPT', 38, 1, { date: dateSerial(2025, 12, 29) }, 'Bench P.', 1, 180, 8, null],
            // Notes mixes text and numbers in the same column — both must survive.
            ['RPT', 37, 4, { date: dateSerial(2025, 12, 18) }, 'Chin-up', 1, 245, 7, 178.6],
            ['RPT', 38, 1, { date: dateSerial(2025, 12, 29) }, 'C. Lat Raise', 1, 11.25, 12, 'L: 12, R:10'],
            [null, null, null, null, null, null, null, null, null],
          ],
        },
        {
          name: 'TRAINING_MAXES',
          rows: [
            ['Date Updated', 'Lift', 'Weight', null],
            [{ date: dateSerial(2026, 9, 25) }, 'Bench P.', { formula: 'B5*0.9', result: 172.49999999999997 }],
          ],
        },
      ]),
    );

    expect(tables).toEqual([
      {
        name: 'LIFT_RECORDS',
        rows: [
          ['Program', 'Cycle #', 'Workout #', 'Date', 'Lift', 'Set #', 'Weight', 'Reps', 'Notes'],
          ['RPT', '38', '1', '12/29/2025', 'Bench P.', '1', '180', '8', ''],
          ['RPT', '37', '4', '12/18/2025', 'Chin-up', '1', '245', '7', '178.6'],
          ['RPT', '38', '1', '12/29/2025', 'C. Lat Raise', '1', '11.25', '12', 'L: 12, R:10'],
        ],
      },
      {
        name: 'TRAINING_MAXES',
        rows: [
          ['Date Updated', 'Lift', 'Weight'],
          ['9/25/2026', 'Bench P.', '172.5'],
        ],
      },
    ]);
  });

  it('places cells by their column reference when earlier cells are absent', () => {
    const [table] = read(buildXlsx([{ name: 'S', rows: [['A', null, 'C'], [null, 'b', null]] }]));
    expect(table?.rows).toEqual([
      ['A', '', 'C'],
      ['', 'b', ''],
    ]);
  });

  it('reads formula strings, inline strings, booleans and errors', () => {
    const [table] = read(
      buildXlsx([
        {
          name: 'S',
          rows: [
            [
              { attrs: 't="str"', inner: '<f>CONCAT("Bench"," P.")</f><v>Bench P.</v>' },
              { attrs: 't="inlineStr"', inner: '<is><t>Squat</t></is>' },
              { attrs: 't="b"', inner: '<v>1</v>' },
              { attrs: 't="e"', inner: '<f>1/0</f><v>#DIV/0!</v>' },
              'end',
            ],
          ],
        },
      ]),
    );
    expect(table?.rows).toEqual([['Bench P.', 'Squat', 'TRUE', '', 'end']]);
  });

  it('decodes XML entities in shared strings, inline strings and formula strings', () => {
    const [table] = read(
      buildXlsx([
        {
          name: 'S',
          rows: [
            [
              'Curls & "Rows" <BB>',
              { attrs: 't="inlineStr"', inner: '<is><t>L: 12 &amp; R: 10</t></is>' },
              { attrs: 't="str"', inner: '<v>caf&#233; &#x2014; ok</v>' },
            ],
          ],
        },
      ]),
    );
    expect(table?.rows).toEqual([['Curls & "Rows" <BB>', 'L: 12 & R: 10', 'café — ok']]);
  });

  it('keeps 15 significant digits', () => {
    const [table] = read(buildXlsx([{ name: 'S', rows: [[123456789012345, 0.1 + 0.2]] }]));
    expect(table?.rows).toEqual([['123456789012345', '0.3']]);
  });

  it('leaves time and duration cells as numbers instead of dates', () => {
    const [table] = read(
      buildXlsx([{ name: 'S', rows: [[{ attrs: 's="2"', inner: '<v>0.0625</v>' }, { attrs: 's="3"', inner: '<v>0.5</v>' }]] }], {
        numFmts: ['[h]:mm:ss', 'h:mm AM/PM'],
      }),
    );
    expect(table?.rows).toEqual([['0.0625', '0.5']]);
  });

  it('converts dates in a 1904-system workbook', () => {
    const [table] = read(buildXlsx([{ name: 'S', rows: [[{ date: 0 }]] }], { date1904: true }));
    expect(table?.rows).toEqual([['1/1/1904']]);
  });

  it('drops phonetic runs from shared strings', () => {
    const files = zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8(
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Squat</t><rPh sb="0" eb="1"><t>reading</t></rPh></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
      ),
    });
    expect(read(files)[0]?.rows).toEqual([['Squat']]);
  });

  it('skips hidden and very hidden tabs', () => {
    const tables = read(
      buildXlsx([
        { name: 'Visible', rows: [['a']] },
        { name: 'Backup', rows: [['b']], state: 'hidden' },
        { name: 'Helper', rows: [['c']], state: 'veryHidden' },
      ]),
    );
    expect(tables.map((t) => t.name)).toEqual(['Visible']);
  });

  it('stops a tab at the row cap and flags it', () => {
    const [table] = read(buildXlsx([{ name: 'S', rows: [['h'], ['1'], ['2'], ['3']] }]), 2);
    expect(table).toEqual({ name: 'S', rows: [['h'], ['1']], overflow: 'rows' });
  });

  it('flags a tab with data past the column cap instead of padding every row to it', () => {
    const wide: (string | null)[] = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => null);
    wide[MAX_TABLE_COLUMNS] = 'stray';
    const [table] = read(buildXlsx([{ name: 'S', rows: [['a'], wide] }]));
    expect(table).toEqual({ name: 'S', rows: [['a']], overflow: 'columns' });
  });

  // The scanner must stay linear on malformed XML: an earlier regex version took
  // seconds on a few hundred KB of unclosed tags and grew quadratically from there.
  it.each([
    ['unclosed rows', '<row>'.repeat(200_000)],
    ['unterminated row tags', '<row '.repeat(200_000)],
    ['unclosed cells', `<row>${'<c>'.repeat(300_000)}</row>`],
    ['unclosed text runs', `<row><c t="inlineStr"><is>${'<t '.repeat(300_000)}</is></c></row>`],
  ])('rejects %s quickly', (_label, body) => {
    const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
    const zip = zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
    });
    const started = Date.now();
    expect(() => read(zip)).toThrow(expect.objectContaining({ code: 'malformed' }));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('drops phonetic runs from inline strings too', () => {
    const [table] = read(
      buildXlsx([{ name: 'S', rows: [[{ attrs: 't="inlineStr"', inner: '<is><t>Squat</t><rPh sb="0" eb="1"><t>reading</t></rPh></is>' }]] }]),
    );
    expect(table?.rows).toEqual([['Squat']]);
  });

  it('reads prefixed elements and rich inline text runs', () => {
    const sheet =
      '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>' +
      '<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:r><x:rPr/><x:t>Bench</x:t></x:r><x:r><x:t xml:space="preserve"> P.</x:t></x:r></x:is></x:c>' +
      '<x:c r="B1"><x:f t="shared" si="0"/><x:v>180</x:v></x:c><x:c r="C1"/></x:row><x:row r="2"/></x:sheetData></x:worksheet>';
    const zip = zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
    });
    expect(read(zip)[0]?.rows).toEqual([['Bench P.', '180']]);
  });

  it('rejects a part over the inflated-size cap before inflating it', () => {
    const big = zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(MAX_XLSX_PART_BYTES + 1) });
    expect(() => read(big)).toThrow(expect.objectContaining({ code: 'too-large' }));
  });

  it('rejects a zip that is not a workbook', () => {
    const notWorkbook = () => read(zipSync({ 'hello.txt': strToU8('hi') }));
    expect(notWorkbook).toThrow(XlsxReadError);
    expect(notWorkbook).toThrow(expect.objectContaining({ code: 'malformed' }));
    expect(() => read(strToU8('not a zip'))).toThrow(expect.objectContaining({ code: 'malformed' }));
  });
});

describe('isDateFormat', () => {
  it.each(['M/d/yyyy', 'd-mmm-yy', 'mmm yyyy', 'mmmm', '[$-409]m/d/yy h:mm AM/PM'])('treats %s as a date', (code) => {
    expect(isDateFormat(code)).toBe(true);
  });

  it.each(['General', '0.00', '0%', 'h:mm', 'h:mm:ss', 'mm:ss', '[h]:mm:ss', 'h:mm AM/PM', '"min" 0'])(
    'does not treat %s as a date',
    (code) => {
      expect(isDateFormat(code)).toBe(false);
    },
  );
});

describe('serialToDate', () => {
  it('converts day serials to M/D/YYYY without consulting the host time zone', () => {
    expect(serialToDate(dateSerial(2026, 11, 4))).toBe('11/4/2026');
    expect(serialToDate(dateSerial(2024, 2, 29) + 0.75)).toBe('2/29/2024');
    expect(serialToDate(0, true)).toBe('1/1/1904');
  });
});
