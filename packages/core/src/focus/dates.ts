import type { FocusBlock, FocusBlockStatus } from '@lifting-logbook/types';

// Focus-block dates are calendar days, not instants: an ISO date string is read as local
// midnight and every comparison is between local midnights, as in the prototype.

const MS_PER_DAY = 86_400_000;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

type BlockDates = Pick<FocusBlock, 'start' | 'period' | 'align'>;

/** First and last day of a block, both inclusive, at local midnight. */
export interface FocusRange {
  start: Date;
  end: Date;
}

/** `'2026-10-01'` → local midnight on that day. */
export function parseIsoDate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new RangeError(`Not an ISO date: ${iso}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Local calendar date → `'YYYY-MM-DD'`. */
export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local midnight on the same calendar day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * A calendar-aligned block covers the whole month or quarter containing `start`. A custom
 * block runs one month or quarter from `start`, ending the day before the same date in the
 * following period.
 */
export function blockRange(block: BlockDates): FocusRange {
  const s = parseIsoDate(block.start);
  if (block.align === 'calendar') {
    if (block.period === 'quarterly') {
      const quarterMonth = Math.floor(s.getMonth() / 3) * 3;
      return {
        start: new Date(s.getFullYear(), quarterMonth, 1),
        end: new Date(s.getFullYear(), quarterMonth + 3, 0),
      };
    }
    return {
      start: new Date(s.getFullYear(), s.getMonth(), 1),
      end: new Date(s.getFullYear(), s.getMonth() + 1, 0),
    };
  }
  const months = block.period === 'quarterly' ? 3 : 1;
  return { start: s, end: new Date(s.getFullYear(), s.getMonth() + months, s.getDate() - 1) };
}

/** "Q4 2026", "October 2026", or "Oct 12 – Nov 11" for a custom block. */
export function rangeLabel(block: BlockDates): string {
  const { start, end } = blockRange(block);
  if (block.align === 'calendar') {
    return block.period === 'quarterly'
      ? `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}`
      : `${MONTH_LONG[start.getMonth()]} ${start.getFullYear()}`;
  }
  const short = (d: Date) => `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
  return `${short(start)} – ${short(end)}`;
}

/** Days from `today` to the block's last day: 0 on the last day, negative once ended. */
export function daysLeft(block: BlockDates, today: Date): number {
  return Math.round((blockRange(block).end.getTime() - startOfDay(today).getTime()) / MS_PER_DAY);
}

/** ISO date of the day after the block ends — where a successor starts. */
export function nextStart(block: BlockDates): string {
  const { end } = blockRange(block);
  return toIsoDate(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1));
}

/** Derived from dates; never stored. */
export function blockStatus(block: BlockDates, today: Date): FocusBlockStatus {
  const day = startOfDay(today).getTime();
  const { start, end } = blockRange(block);
  if (day < start.getTime()) return 'queued';
  if (day > end.getTime()) return 'ended';
  return 'active';
}
