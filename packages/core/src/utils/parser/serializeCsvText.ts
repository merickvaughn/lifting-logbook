import { SpreadsheetCell } from '../../models';
import { stringifyCsv } from './stringifyCsv';

/**
 * Serializes a table to CSV text, the inverse of `parseCsvText` (#947). `stringifyCsv` handles
 * the quoting; this adds the cell types a table can hold beyond text. Dates are written as
 * `YYYY-MM-DD` from their UTC calendar day, which is how the parsers read them back.
 */
export function serializeCsvText(rows: readonly (readonly SpreadsheetCell[])[]): string {
  return stringifyCsv(rows.map((row) => row.map(cellText)));
}

function cellText(cell: SpreadsheetCell): string {
  if (cell === null) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return String(cell);
}
