import { nextStart, parseIsoDate, toIsoDate } from '@lifting-logbook/core';
import type { FocusBlockResponse } from '@lifting-logbook/types';
import type { ProgramPhase } from './programPlan';
import type { WorkoutDay } from './workoutPlan';

// Layout math for the calendar page (#1059): where each bar sits on the Gantt, which lanes
// it has, and the dates of the program's phases. Dates are ISO calendar days; the arithmetic
// runs on UTC midnights, as in core's focus date helpers, so it never depends on the host's
// time zone.

const MS_PER_DAY = 86_400_000;
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** The first and last day the Gantt shows, both inclusive. */
export interface CalendarWindow {
  start: string;
  end: string;
}

/**
 * Seven months: the one before `today`'s, so a block that just ended stays in view, through
 * five after it, so a queued quarter fits. Bars outside the window are clipped.
 */
export function calendarWindow(today: string): CalendarWindow {
  const t = parseIsoDate(today);
  const year = t.getUTCFullYear();
  const month = t.getUTCMonth();
  return {
    start: toIsoDate(new Date(Date.UTC(year, month - 1, 1))),
    end: toIsoDate(new Date(Date.UTC(year, month + 6, 0))),
  };
}

function dayMs(iso: string): number {
  return parseIsoDate(iso).getTime();
}

function windowSpan(window: CalendarWindow): { from: number; span: number } {
  const from = dayMs(window.start);
  return { from, span: dayMs(window.end) + MS_PER_DAY - from };
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Horizontal placement in percent of the track width. */
export interface BarPlacement {
  left: number;
  width: number;
}

/**
 * Where a bar for the days `start` through `end` (both inclusive) sits, or null when none
 * of it is inside the window. A bar partly outside is cut at the window's edge.
 */
export function barPlacement(start: string, end: string, window: CalendarWindow): BarPlacement | null {
  const { from, span } = windowSpan(window);
  const left = clampPct(((dayMs(start) - from) / span) * 100);
  const right = clampPct(((dayMs(end) + MS_PER_DAY - from) / span) * 100);
  return right > left ? { left, width: right - left } : null;
}

/** The Today marker's position: the middle of today's day, in percent of the track. */
export function todayOffset(today: string, window: CalendarWindow): number {
  const { from, span } = windowSpan(window);
  return clampPct(((dayMs(today) + MS_PER_DAY / 2 - from) / span) * 100);
}

export interface MonthTick {
  /** First day of the month. */
  start: string;
  /** "Oct", or "Jan ’27" for a January, so the year change shows. */
  label: string;
  left: number;
}

export function monthTicks(window: CalendarWindow): MonthTick[] {
  const { from, span } = windowSpan(window);
  const last = parseIsoDate(window.end);
  const ticks: MonthTick[] = [];
  const first = parseIsoDate(window.start);
  for (
    let d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    d <= last;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    ticks.push({
      start: toIsoDate(d),
      label: d.getUTCMonth() === 0 ? `${MONTH.format(d)} ’${String(d.getUTCFullYear()).slice(2)}` : MONTH.format(d),
      left: clampPct(((d.getTime() - from) / span) * 100),
    });
  }
  return ticks;
}

function ordinal(n: number): string {
  const teen = Math.floor(n / 10) % 10 === 1;
  const suffix = teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** One Gantt lane: every focus block in a series, oldest first. */
export interface FocusLane {
  series: string;
  blocks: FocusBlockResponse[];
  /** "Quarterly", or "Monthly · from the 12th" for a custom-start series. */
  label: string;
}

/**
 * One lane per series, ordered by the priority of the series' active focus block (then its
 * queued one, for a series that has not started), highest first. A lane whose blocks all fall
 * outside the window is dropped, so old series don't leave empty rows.
 */
export function focusLanes(blocks: readonly FocusBlockResponse[], window: CalendarWindow): FocusLane[] {
  const bySeries = new Map<string, FocusBlockResponse[]>();
  for (const block of blocks) {
    bySeries.set(block.series, [...(bySeries.get(block.series) ?? []), block]);
  }
  const rank = (lane: FocusBlockResponse[]): number =>
    (lane.find((b) => b.status === 'active') ?? lane.find((b) => b.status === 'queued'))?.priority ??
    Number.POSITIVE_INFINITY;

  return [...bySeries.entries()]
    .flatMap(([series, members]) => {
      const sorted = [...members].sort((a, b) => a.rangeStart.localeCompare(b.rangeStart));
      const current = sorted.find((b) => b.status === 'active') ?? sorted.at(-1);
      if (!current) return [];
      const period = current.period === 'quarterly' ? 'Quarterly' : 'Monthly';
      const label =
        current.align === 'custom' ? `${period} · from the ${ordinal(parseIsoDate(current.start).getUTCDate())}` : period;
      return [{ series, blocks: sorted, label }];
    })
    .filter((lane) => lane.blocks.some((b) => barPlacement(b.rangeStart, b.rangeEnd, window)))
    .sort((a, b) => rank(a.blocks) - rank(b.blocks) || a.series.localeCompare(b.series));
}

/** "Week 3 of 13": which week of the focus block `today` is in. */
export function blockWeek(block: Pick<FocusBlockResponse, 'rangeStart' | 'rangeEnd'>, today: string): {
  week: number;
  weeks: number;
} {
  const start = dayMs(block.rangeStart);
  const days = (dayMs(block.rangeEnd) - start) / MS_PER_DAY + 1;
  const weeks = Math.ceil(days / 7);
  const week = Math.floor((dayMs(today) - start) / MS_PER_DAY / 7) + 1;
  return { week: Math.max(1, Math.min(weeks, week)), weeks };
}

/**
 * The focus block a queued one auto-rolls from: the one in its series set to roll, ending
 * the day before it starts. Undefined for a block the user queued.
 */
export function autoRollSource(
  block: FocusBlockResponse,
  blocks: readonly FocusBlockResponse[],
): FocusBlockResponse | undefined {
  return blocks.find(
    (b) =>
      b.id !== block.id &&
      b.series === block.series &&
      b.onEnd === 'autoroll' &&
      nextStart(b) === block.start,
  );
}

/** A program phase with the dates of its first and last workouts. */
export interface DatedPhase {
  name: string;
  type: ProgramPhase['type'];
  start: string;
  end: string;
  /** Program weeks in the phase, as the Macrocycle Plan counts them. */
  weeks: number;
}

/**
 * Dates each phase from its workouts as the dashboard dates them (`dateOf`, from
 * `workoutDateResolver`), so a rescheduled workout moves its phase's bar. A phase with no
 * workouts is left out.
 */
export function datedProgramPhases(
  phases: readonly Pick<ProgramPhase, 'name' | 'type' | 'startWeek' | 'endWeek'>[],
  days: readonly Pick<WorkoutDay, 'workoutNum' | 'week' | 'date'>[],
  dateOf: (day: Pick<WorkoutDay, 'workoutNum' | 'date'>) => string,
): DatedPhase[] {
  return phases.flatMap((phase) => {
    const dates = days
      .filter((d) => d.week >= phase.startWeek && d.week <= phase.endWeek)
      .map(dateOf)
      .sort();
    const [start] = dates;
    const end = dates.at(-1);
    const weeks = phase.endWeek - phase.startWeek + 1;
    return start && end ? [{ name: phase.name, type: phase.type, start, end, weeks }] : [];
  });
}
