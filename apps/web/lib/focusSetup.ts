// Pure logic for the focus setup page (`/programs/focus`, #1057), ported from the
// prototype's `focus-setup.jsx` (docs/mockups/focus-work.html). Status always comes from
// the dates through core's `blockStatus`, never from a stored field (ADR-039).

import {
  blockRange,
  blockStatus,
  daysLeft,
  defaultFocusPool,
  nextStart,
  parseIsoDate,
} from '@lifting-logbook/core';
import {
  DEFAULT_FOCUS_TIMER,
  FOCUS_AREAS,
  type CreateFocusBlockRequest,
  type FocusArea,
  type FocusBlock,
  type FocusInclude,
  type FocusOverlap,
  type FocusProgression,
  type FocusSelection,
  type UpdateFocusBlockRequest,
} from '@lifting-logbook/types';

/** A block ending within this many days asks what comes next, as in the prototype. */
export const RENEW_WINDOW_DAYS = 10;

export const SELECTION_LABELS: Readonly<Record<FocusSelection, string>> = {
  rules: 'Rules',
  rotate: 'Rotate',
  fixed: 'Fixed',
  pick: 'I pick',
};

export const SELECTION_HINTS: Readonly<Record<FocusSelection, string>> = {
  rules: 'Every eligible lift in the pool, after your rules and overlap handling.',
  rotate: 'One lift per workout, cycling through the pool. Lifts marked Always are added on top.',
  fixed: 'The first eligible lift in the pool, every workout.',
  pick: 'Eligible lifts are offered as suggestions. You choose on the day.',
};

export const OVERLAP_LABELS: Readonly<Record<FocusOverlap, string>> = {
  swap: 'Swap',
  reduce: 'Reduce',
  skip: 'Skip',
  anyway: 'Do it anyway',
};

export const PROGRESSION_LABELS: Readonly<Record<FocusProgression, string>> = {
  double: 'Double progression',
  fixed: 'Fixed',
  tm: '% of TM',
  rpe: 'RPE',
};

export const INCLUDE_LABELS: Readonly<Record<FocusInclude, string>> = {
  auto: 'Follows selection',
  always: 'Always',
  rule: 'Only when a lift isn’t planned',
  swap: 'Swap target only',
  off: 'Off',
};

/**
 * The user's calendar day as an ISO date, from the browser's clock and time zone. Every
 * focus endpoint takes it as `?today=`, since the server cannot know the user's zone.
 */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Active focus blocks, highest priority first. */
export function activeBlocks(blocks: readonly FocusBlock[], today: string): FocusBlock[] {
  return blocks
    .filter((block) => blockStatus(block, today) === 'active')
    .sort((a, b) => a.priority - b.priority);
}

/** One row of the "Up next" list: a queued block, and the block auto-rolling into it. */
export interface UpNextRow {
  block: FocusBlock;
  /** The predecessor this block is the auto-roll of; undefined for one the user queued. */
  rolledFrom: FocusBlock | undefined;
}

/**
 * Queued focus blocks, soonest first. A queued block is an auto-roll when its series has
 * a block set to auto-roll that ends the day before it starts: the API creates those
 * successors itself (`expandRollovers`), so the page never does.
 */
export function upNext(blocks: readonly FocusBlock[], today: string): UpNextRow[] {
  return blocks
    .filter((block) => blockStatus(block, today) === 'queued')
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.priority - b.priority))
    .map((block) => ({
      block,
      rolledFrom: blocks.find(
        (other) =>
          other.id !== block.id &&
          other.series === block.series &&
          other.onEnd === 'autoroll' &&
          nextStart(other) === block.start,
      ),
    }));
}

/**
 * Active blocks that ask what follows them: set to prompt, ending within
 * {@link RENEW_WINDOW_DAYS}, not dismissed with "Let it end", and with nothing queued in
 * their series yet.
 */
export function renewalPrompts(
  blocks: readonly FocusBlock[],
  today: string,
  dismissed: ReadonlySet<string>,
): FocusBlock[] {
  return activeBlocks(blocks, today).filter(
    (block) =>
      block.onEnd === 'prompt' &&
      daysLeft(block, today) <= RENEW_WINDOW_DAYS &&
      !dismissed.has(block.id) &&
      !blocks.some((other) => other.series === block.series && blockStatus(other, today) === 'queued'),
  );
}

/**
 * The ids `PUT /focus/blocks/order` takes after moving `id` one place up (`-1`) or down
 * (`+1`) among the active blocks: every block that has not ended, highest priority first.
 * Queued blocks keep their places. Null when the block is already at that end.
 */
export function reorderedIds(
  blocks: readonly FocusBlock[],
  today: string,
  id: string,
  delta: -1 | 1,
): string[] | null {
  const order = blocks
    .filter((block) => blockStatus(block, today) !== 'ended')
    .sort((a, b) => a.priority - b.priority);
  const active = order.filter((block) => blockStatus(block, today) === 'active');
  const from = active.findIndex((block) => block.id === id);
  const neighbor = active[from + delta];
  if (from < 0 || !neighbor) return null;
  const ids = order.map((block) => block.id);
  const i = ids.indexOf(id);
  const j = ids.indexOf(neighbor.id);
  ids[i] = neighbor.id;
  ids[j] = id;
  return ids;
}

/** Priorities as the API assigns them after a reorder: each block's 1-based position. */
export function withPriorities(blocks: readonly FocusBlock[], ids: readonly string[]): FocusBlock[] {
  return blocks.map((block) => {
    const index = ids.indexOf(block.id);
    return index < 0 ? block : { ...block, priority: index + 1 };
  });
}

/**
 * `patch` for a running block, re-anchored so the block still covers `today`. Changing the
 * period or alignment keeps `start`, which can leave a running block entirely in the past:
 * a quarterly block from Oct 1 switched to Monthly in November would cover October alone,
 * end, and leave the page. When that would happen, the block restarts from this month (or
 * this quarter, which the 1st of this month also falls in) for calendar alignment, or from
 * today for a custom date.
 */
export function anchoredPatch(
  block: FocusBlock,
  patch: UpdateFocusBlockRequest,
  today: string,
): UpdateFocusBlockRequest {
  if (patch.start !== undefined || (patch.period === undefined && patch.align === undefined)) return patch;
  const next = { ...block, ...patch };
  if (blockStatus(block, today) !== 'active' || blockStatus(next, today) === 'active') return patch;
  return { ...patch, start: next.align === 'calendar' ? `${today.slice(0, 8)}01` : today };
}

/**
 * The queued block that follows `before` in its series — its renewal, queued area or
 * auto-roll successor — moved to start the day after `after` ends. Without the move, a
 * longer period would overlap it and a shorter one would leave a gap. Null when nothing
 * follows, or it already starts there.
 */
export function shiftedFollowOn(
  blocks: readonly FocusBlock[],
  before: FocusBlock,
  after: FocusBlock,
  today: string,
): { id: string; start: string } | null {
  const start = nextStart(after);
  const followOn = blocks.find(
    (other) =>
      other.id !== before.id &&
      other.series === before.series &&
      blockStatus(other, today) === 'queued' &&
      (other.start === nextStart(before) || other.start <= blockRange(after).end),
  );
  return followOn && followOn.start !== start ? { id: followOn.id, start } : null;
}

/** The auto-roll successor the API created for `block`, if it has one queued. */
export function autoRollSuccessor(blocks: readonly FocusBlock[], block: FocusBlock, today: string): FocusBlock | undefined {
  return upNext(blocks, today).find((row) => row.rolledFrom?.id === block.id)?.block;
}

/**
 * True for a start date the page can save: a real ISO date from 2000 on (a date input
 * reports "0002-10-26" partway through typing a year), on which the block has not
 * already ended. An ended block leaves this page, so the user could not undo it here.
 */
export function isUsableStart(block: FocusBlock, start: string, today: string): boolean {
  try {
    parseIsoDate(start);
  } catch {
    return false;
  }
  return start >= '2000-01-01' && blockStatus({ ...block, start }, today) !== 'ended';
}

/** The first area without an active block, so "+ Add focus block" starts somewhere new. */
export function suggestedArea(blocks: readonly FocusBlock[], today: string): FocusArea {
  const taken = new Set(activeBlocks(blocks, today).map((block) => block.area));
  return FOCUS_AREAS.find((area) => !taken.has(area)) ?? FOCUS_AREAS[0];
}

/**
 * A new focus block for `area`, as the prototype's "+ Add focus block" makes it: this
 * calendar month, every eligible lift, one set fewer when the program already trains the
 * area, double progression, and the area's default lift pool.
 */
export function newFocusBlock(area: FocusArea, today: string): CreateFocusBlockRequest {
  return {
    area,
    period: 'monthly',
    align: 'calendar',
    start: `${today.slice(0, 8)}01`,
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    timer: { ...DEFAULT_FOCUS_TIMER },
    onEnd: 'prompt',
    nextArea: null,
    pool: defaultFocusPool(area),
  };
}

/**
 * The block that follows `block` in its series, from the renewal prompt: the same
 * settings from the day after it ends. Renewing the same area keeps its pool; a new area
 * starts from that area's default pool.
 */
export function followOnBlock(block: FocusBlock, area: FocusArea): CreateFocusBlockRequest {
  return {
    series: block.series,
    area,
    period: block.period,
    align: block.align,
    start: nextStart(block),
    selection: block.selection,
    overlap: block.overlap,
    progression: block.progression,
    timer: { ...block.timer },
    onEnd: 'prompt',
    nextArea: null,
    pool: area === block.area ? block.pool.map((entry) => ({ ...entry })) : defaultFocusPool(area),
  };
}

/** A workout of the current macrocycle, as the page lists it under "This week". */
export interface FocusWeekWorkout {
  workoutNum: number;
  week: number;
  /** ISO date. */
  date: string;
  done: boolean;
}

/**
 * The workouts of the week in progress: the first week with a workout not yet done on or
 * after `today`, or the last week once every one is behind. Mirrors the Macrocycle
 * Dashboard's current week.
 */
export function currentWeek(workouts: readonly FocusWeekWorkout[], today: string): FocusWeekWorkout[] {
  const upcoming = workouts.find((workout) => !workout.done && workout.date >= today);
  const week = upcoming?.week ?? workouts[workouts.length - 1]?.week;
  return workouts.filter((workout) => workout.week === week);
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Mon, Oct 26" for an ISO date. */
export function shortDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return WEEKDAY.format(new Date(Date.UTC(year, month - 1, day)));
}

/** "Oct 1 – Dec 31, 2026": a block's run for the Period hint. */
export function runLabel(rangeStart: string, rangeEnd: string): string {
  const year = rangeEnd.slice(0, 4);
  const [a, b] = [rangeStart, rangeEnd].map((iso) => shortDate(iso).split(', ')[1]);
  return `${a} – ${b}, ${year}`;
}

/** The month a block's successor starts in, for "Renew for November". */
export function nextMonthName(block: FocusBlock): string {
  const start = nextStart(block);
  const [year, month] = start.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

/** "today", "in 1 day", "in 6 days". */
export function endsIn(days: number): string {
  if (days <= 0) return 'today';
  return days === 1 ? 'in 1 day' : `in ${days} days`;
}
