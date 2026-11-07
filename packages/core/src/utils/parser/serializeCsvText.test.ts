import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseCsvText } from './parseCsvText';
import { serializeCsvText } from './serializeCsvText';

const FIXTURES_DIR = join(__dirname, '../../../tests/fixtures');
const csvFixtures = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.csv'));

describe('serializeCsvText', () => {
  it('has parser fixtures to round-trip', () => {
    expect(csvFixtures.length).toBeGreaterThan(0);
  });

  it.each(csvFixtures)('round-trips %s through parseCsvText', (name) => {
    const table = parseCsvText(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
    expect(table.length).toBeGreaterThan(0);
    expect(parseCsvText(serializeCsvText(table))).toEqual(table);
  });

  it('round-trips quotes, commas, line breaks and non-ASCII text', () => {
    const table = [
      ['Lift', 'Notes'],
      ['Squat', 'said "paused", then\nstopped'],
      ['Überzug', 'first\r\nsecond'],
    ];
    expect(parseCsvText(serializeCsvText(table))).toEqual(table);
  });

  it('writes numbers, booleans, null and UTC dates in the form the parsers read', () => {
    expect(serializeCsvText([[-2.5, true, false, null, new Date('2026-11-06T00:00:00.000Z')]])).toBe(
      '-2.5,TRUE,FALSE,,2026-11-06',
    );
  });
});
