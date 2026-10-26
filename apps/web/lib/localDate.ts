/**
 * The calendar day `date` falls on in the browser's own time zone, as `YYYY-MM-DD`.
 *
 * Focus-block endpoints take the user's calendar day as `?today=` because the server cannot
 * know the user's time zone (ADR-039 §5). `toISOString()` would give the UTC day instead,
 * which is a different day for part of every evening west of UTC.
 */
export function localIsoDate(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
