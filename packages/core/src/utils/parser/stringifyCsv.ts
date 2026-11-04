/**
 * Serializes a table of strings to RFC 4180 CSV — the inverse of `parseCsvText`.
 * A cell is quoted only when it contains a comma, a double quote, or a line
 * break; embedded quotes are doubled.
 */
export function stringifyCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\n');
}

function escapeCell(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
