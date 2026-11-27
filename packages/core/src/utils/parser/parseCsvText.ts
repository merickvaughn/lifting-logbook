import { CsvError, parse } from 'csv-parse/sync';
import { SpreadsheetCell } from '../../models';

/**
 * The text isn't valid CSV: a row with a different number of cells from the first row, or a
 * quote that isn't closed. The message names the line, for a client to show the lifter (#1497).
 */
export class CsvParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'CsvParseError';
  }
}

const PARSE_OPTIONS = { skip_empty_lines: true };

/**
 * Parses a raw CSV string into a 2D array of SpreadsheetCells.
 * The first row is treated as the header row (same convention as parseLiftRecords).
 *
 * @throws CsvParseError when the text isn't valid CSV.
 */
export function parseCsvText(text: string): SpreadsheetCell[][] {
  try {
    return parse(text, PARSE_OPTIONS) as SpreadsheetCell[][];
  } catch (err) {
    if (!(err instanceof CsvError)) throw err;
    // csv-parse sets `lines` on every CsvError but types its context fields as unknown.
    const line = Number(err.lines);
    if (err.code === 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH') {
      // The error doesn't carry the expected count, so read it off the first row.
      const [first = []] = parse(text, { ...PARSE_OPTIONS, to: 1 }) as string[][];
      const got = (err.record as string[] | undefined)?.length ?? 0;
      throw new CsvParseError(
        `Line ${line} has ${got} cells, but the first row has ${first.length}. ` +
          'Every row of the file needs the same number of cells.',
        line,
      );
    }
    throw new CsvParseError(`The file isn't valid CSV: ${err.message}`, line);
  }
}
