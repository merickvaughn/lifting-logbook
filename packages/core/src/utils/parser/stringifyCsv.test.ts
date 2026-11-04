import { parseCsvText } from './parseCsvText';
import { stringifyCsv } from './stringifyCsv';

describe('stringifyCsv', () => {
  it('leaves plain cells unquoted', () => {
    expect(stringifyCsv([['Date Updated', 'Lift', 'Weight'], ['9/25/2026', 'Bench P.', '172.5']])).toBe(
      'Date Updated,Lift,Weight\n9/25/2026,Bench P.,172.5',
    );
  });

  it('round-trips commas, quotes, line breaks and empty cells through parseCsvText', () => {
    const rows = [
      ['Program', 'Lift', 'Notes'],
      ['RPT', 'C. Lat Raise', 'L: 12, R:10'],
      ['RPT', 'Deadlift', 'said "mixed" grip'],
      ['RPT', 'Squat', 'line one\nline two'],
      ['RPT', 'Dip', ''],
    ];
    expect(parseCsvText(stringifyCsv(rows))).toEqual(rows);
  });
});
