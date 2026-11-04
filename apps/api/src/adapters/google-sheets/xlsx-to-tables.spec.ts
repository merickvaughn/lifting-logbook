import { strToU8, zipSync } from 'fflate';
import { serialToDate, xlsxToTables } from './xlsx-to-tables';
import { buildXlsx, dateSerial } from './xlsx.fixture';

describe('xlsxToTables', () => {
  it('flattens each worksheet to a rectangular string table', () => {
    const tables = xlsxToTables(
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
    const [table] = xlsxToTables(buildXlsx([{ name: 'S', rows: [['A', null, 'C'], [null, 'b', null]] }]));
    expect(table?.rows).toEqual([
      ['A', '', 'C'],
      ['', 'b', ''],
    ]);
  });

  it('rejects a zip that is not a workbook', () => {
    expect(() => xlsxToTables(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow('Not an XLSX workbook');
    expect(() => xlsxToTables(strToU8('not a zip'))).toThrow();
  });
});

describe('serialToDate', () => {
  it('converts day serials to M/D/YYYY without consulting the host time zone', () => {
    expect(serialToDate(dateSerial(2026, 11, 4))).toBe('11/4/2026');
    expect(serialToDate(dateSerial(2024, 2, 29) + 0.75)).toBe('2/29/2024');
    expect(serialToDate(0, true)).toBe('1/1/1904');
  });
});
