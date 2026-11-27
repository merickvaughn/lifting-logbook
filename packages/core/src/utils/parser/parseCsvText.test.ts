import { CsvParseError, parseCsvText } from './parseCsvText';

describe('parseCsvText', () => {
  it('parses a well-formed file, skipping empty lines', () => {
    expect(parseCsvText('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  // #1497: csv-parse's own error reached the API as a 500.
  it('names the line and both cell counts for a row of a different length', () => {
    const parse = () => parseCsvText('a,b,c\n1,2,3\n\n4,5\n');
    expect(parse).toThrow(CsvParseError);
    expect(parse).toThrow(
      'Line 4 has 2 cells, but the first row has 3. Every row of the file needs the same number of cells.',
    );
    try {
      parse();
    } catch (err) {
      expect((err as CsvParseError).line).toBe(4);
    }
  });

  it('names the line of a quote that is never closed', () => {
    expect(() => parseCsvText('a,b\n"x,1\n')).toThrow(
      new CsvParseError(
        "The file isn't valid CSV: Quote Not Closed: the parsing is finished with an opening quote at line 2",
        2,
      ),
    );
  });
});
