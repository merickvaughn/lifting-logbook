import type { FocusBlock, FocusBlockStatus } from '@lifting-logbook/types';

// Focus-block dates are calendar days written as ISO date strings ('YYYY-MM-DD'), and so is
// `today`: which calendar day it is for the user is the caller's call. The arithmetic runs
// on UTC midnights, so no result depends on the host's time zone.

const MS_PER_DAY = 86_400_000;
const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

type BlockDates = Pick<FocusBlock, 'start' | 'period' | 'align'>;

/** First and last day of a block, both inclusive, as ISO dates. */
export interface FocusRange {
  start: string;
  end: string;
}

/** `'2026-10-01'` → UTC midnight on that day. Throws on anything else, including '2026-02-30'. */
export function parseIsoDate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const date = match ? utcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
  // Round-tripping rejects a day the month doesn't have, which Date would roll forward.
  if (!date || toIsoDate(date) !== iso) throw new RangeError(`Not an ISO date: ${iso}`);
  return date;
}

/** The UTC calendar day of `date` as `'YYYY-MM-DD'` — the day a UTC-midnight `LiftRecord.date` is for. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Day overflow rolls into the next month, as with `Date.UTC`. */
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/**
 * A calendar-aligned block covers the whole month or quarter containing `start`. A custom
 * block runs one month or quarter from `start`, ending the day before the same date in the
 * following period — or on that period's last day when it is shorter: a monthly block from
 * Jan 31 ends Feb 28 (29 in a leap year), not on a rolled-over "Feb 30". Its successor
 * starts Mar 1, so a series anchored late in a month drifts to the 1st.
 */
export function blockRange(block: BlockDates): FocusRange {
  const s = parseIsoDate(block.start);
  const year = s.getUTCFullYear();
  const month = s.getUTCMonth();
  if (block.align === 'calendar') {
    const first = block.period === 'quarterly' ? Math.floor(month / 3) * 3 : month;
    const months = block.period === 'quarterly' ? 3 : 1;
    return { start: toIsoDate(utcDate(year, first, 1)), end: toIsoDate(utcDate(year, first + months, 0)) };
  }
  const target = month + (block.period === 'quarterly' ? 3 : 1);
  const lastDayOfTarget = utcDate(year, target + 1, 0).getUTCDate();
  const end = utcDate(year, target, Math.min(s.getUTCDate() - 1, lastDayOfTarget));
  return { start: block.start, end: toIsoDate(end) };
}

/** "Q4 2026", "October 2026", or "Oct 12 – Nov 11" for a custom block. */
export function rangeLabel(block: BlockDates): string {
  const { start, end } = blockRange(block);
  const first = parseIsoDate(start);
  if (block.align === 'calendar') {
    return block.period === 'quarterly'
      ? `Q${Math.floor(first.getUTCMonth() / 3) + 1} ${first.getUTCFullYear()}`
      : MONTH_YEAR.format(first);
  }
  return `${MONTH_DAY.format(first)} – ${MONTH_DAY.format(parseIsoDate(end))}`;
}

/** Days from `today` to the block's last day: 0 on the last day, negative once ended. */
export function daysLeft(block: BlockDates, today: string): number {
  return (parseIsoDate(blockRange(block).end).getTime() - parseIsoDate(today).getTime()) / MS_PER_DAY;
}

/** ISO date of the day after the block ends — where a successor starts. */
export function nextStart(block: BlockDates): string {
  return toIsoDate(new Date(parseIsoDate(blockRange(block).end).getTime() + MS_PER_DAY));
}

/** Derived from dates; never stored. */
export function blockStatus(block: BlockDates, today: string): FocusBlockStatus {
  parseIsoDate(today);
  const { start, end } = blockRange(block);
  // ISO dates compare correctly as strings.
  if (today < start) return 'queued';
  if (today > end) return 'ended';
  return 'active';
}
