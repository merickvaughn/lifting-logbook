import { MUSCLE_GROUPS } from '@lifting-logbook/types';
import type { ResolvedMuscleTargets } from '../../catalog/muscles';
import { MOVEMENT_PATTERN_ROWS, type MovementPatternRow } from '../../catalog/patterns';

/**
 * One lift's working sets in one week — prescribed (a spec row's `sets`) or logged (a
 * count of lift records). Warm-ups never belong here: a spec's `sets` counts work sets
 * only, and the logger records only working sets.
 */
export interface VolumeSlot {
  week: number;
  lift: string;
  sets: number;
}

/** How much one set of a lift counts toward one row. */
export interface VolumeCredit {
  key: string;
  weight: number;
}

export interface VolumeCount {
  key: string;
  sets: number;
}

/** A lift no row could claim, with its set total — shown as "not counted", never dropped. */
export interface UncountedLift {
  lift: string;
  sets: number;
}

export interface WeeklyVolume {
  week: number;
  counts: VolumeCount[];
  uncounted: UncountedLift[];
}

/** Credit a secondary muscle earns per working set — the "fractional" method (ADR-036). */
export const SECONDARY_SET_CREDIT = 0.5;

/**
 * Locale-independent string order. `localeCompare` without a locale follows the runtime's
 * default, so a server render and the browser's re-render could order the same free-text
 * labels differently (Czech sorts "hips" before "chin") and fail hydration.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The generic counter behind every weekly volume breakdown: groups `slots` by week
 * (ascending) and adds `sets × weight` to each row the lift's credits name.
 *
 * Rows merge case-insensitively under the first spelling seen, so a user's legacy
 * "quads" tag and a default "Quads" land in one row. A lift whose credits are undefined
 * or empty is reported in `uncounted` instead. A slot whose `sets` is not a positive
 * finite number — a program editor mid-keystroke — adds nothing, but its week still
 * appears (with whatever else it holds), so zeroing a week's sets reads as an empty week
 * rather than a week that silently vanished.
 *
 * `counts` come back in first-seen order; the named wrappers below sort for display, and
 * {@link toVolumeTable} aligns several breakdowns into one table.
 */
export function weeklySetCounts(
  slots: readonly VolumeSlot[],
  creditsFor: (lift: string) => readonly VolumeCredit[] | undefined,
): WeeklyVolume[] {
  const weeks = new Map<
    number,
    { counts: Map<string, VolumeCount>; uncounted: Map<string, UncountedLift> }
  >();

  for (const slot of slots) {
    let week = weeks.get(slot.week);
    if (!week) {
      week = { counts: new Map(), uncounted: new Map() };
      weeks.set(slot.week, week);
    }
    if (!Number.isFinite(slot.sets) || slot.sets <= 0) continue;

    const credits = creditsFor(slot.lift);
    if (!credits || credits.length === 0) {
      const entry = week.uncounted.get(slot.lift) ?? { lift: slot.lift, sets: 0 };
      entry.sets += slot.sets;
      week.uncounted.set(slot.lift, entry);
      continue;
    }
    for (const credit of credits) {
      const id = credit.key.toLowerCase();
      const entry = week.counts.get(id) ?? { key: credit.key, sets: 0 };
      entry.sets += slot.sets * credit.weight;
      week.counts.set(id, entry);
    }
  }

  return [...weeks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, { counts, uncounted }]) => ({
      week,
      counts: [...counts.values()],
      uncounted: [...uncounted.values()],
    }));
}

/** The credits a resolved muscle target earns per set: 1 per primary, ½ per secondary. */
export function muscleCredits(targets: ResolvedMuscleTargets): VolumeCredit[] {
  return [
    ...targets.primary.map((key) => ({ key, weight: 1 })),
    ...targets.secondary.map((key) => ({ key, weight: SECONDARY_SET_CREDIT })),
  ];
}

/** Vocabulary position for sorting; labels outside the vocabulary sort after it. */
function rankIn(order: readonly string[], key: string): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

/** Heaviest first, then vocabulary order, then code-unit order for free-text labels. */
function compareMuscleRows(a: { key: string; total: number }, b: { key: string; total: number }): number {
  return (
    b.total - a.total ||
    rankIn(MUSCLE_GROUPS, a.key) - rankIn(MUSCLE_GROUPS, b.key) ||
    byCodeUnit(a.key, b.key)
  );
}

/** Fixed pattern order, so push/pull pairs read side by side. */
function comparePatternRows(a: { key: string }, b: { key: string }): number {
  return rankIn(MOVEMENT_PATTERN_ROWS, a.key) - rankIn(MOVEMENT_PATTERN_ROWS, b.key) || byCodeUnit(a.key, b.key);
}

/**
 * Weekly sets per muscle group. Rows sort by sets (descending), then vocabulary order,
 * then code-unit order for free-text labels, so the heaviest-trained muscles lead.
 */
export function weeklySetsByMuscleGroup(
  slots: readonly VolumeSlot[],
  targetsFor: (lift: string) => ResolvedMuscleTargets,
): WeeklyVolume[] {
  return weeklySetCounts(slots, (lift) => muscleCredits(targetsFor(lift))).map((week) => ({
    ...week,
    counts: [...week.counts].sort((a, b) =>
      compareMuscleRows({ key: a.key, total: a.sets }, { key: b.key, total: b.sets }),
    ),
  }));
}

/**
 * Weekly sets per movement pattern. A set counts once toward each row its lift earns;
 * rows keep the fixed {@link MOVEMENT_PATTERN_ROWS} order, so push/pull pairs read side
 * by side from week to week.
 */
export function weeklySetsByPattern(
  slots: readonly VolumeSlot[],
  patternsFor: (lift: string) => readonly MovementPatternRow[] | undefined,
): WeeklyVolume[] {
  return weeklySetCounts(slots, (lift) =>
    patternsFor(lift)?.map((key) => ({ key, weight: 1 })),
  ).map((week) => ({ ...week, counts: [...week.counts].sort(comparePatternRows) }));
}

/** `3` → "3", `1.5` → "1.5". Counts are multiples of ½, so one decimal is exact. */
export function formatSetCount(sets: number): string {
  const rounded = Math.round(sets * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * The weeks whose breakdowns are identical — not necessarily consecutive (weeks 1 and 3
 * can share a column while week 2 differs), so label a column with its week list, never
 * as a range.
 */
export interface VolumeColumn {
  weeks: number[];
  volume: WeeklyVolume;
}

/**
 * Merges weeks with identical counts into one column, in first-appearance order — so a
 * program whose every week matches (5-3-1's three weeks, a one-week preset) renders a
 * single "sets / week" column instead of repeating it. A week that exists but counts
 * nothing (every slot zeroed) is its own column, never merged away.
 */
export function collapseIdenticalWeeks(weeks: readonly WeeklyVolume[]): VolumeColumn[] {
  const signature = (week: WeeklyVolume) =>
    JSON.stringify([
      week.counts.map((c) => [c.key.toLowerCase(), c.sets]).sort(),
      week.uncounted.map((u) => [u.lift, u.sets]).sort(),
    ]);

  const columns = new Map<string, VolumeColumn>();
  for (const week of weeks) {
    const key = signature(week);
    const column = columns.get(key);
    if (column) column.weeks.push(week.week);
    else columns.set(key, { weeks: [week.week], volume: week });
  }
  return [...columns.values()];
}

/** One row of a multi-column volume table: its key and its sets in each column. */
export interface VolumeTableRow {
  key: string;
  sets: number[];
}

/** Several breakdowns aligned into one table — one row per key across every column. */
export interface VolumeTable {
  rows: VolumeTableRow[];
  uncounted: { lift: string; sets: number[] }[];
}

/** How a table's rows are ordered: muscles by weight, patterns in their fixed order. */
export type VolumeRowOrder = 'muscle' | 'pattern';

/**
 * Aligns several breakdowns — per-week columns, or a Planned | Done pair — into one table
 * with a single row order, so no caller re-implements the ordering or the key join.
 *
 * Keys merge case-insensitively under the first spelling seen, exactly as
 * {@link weeklySetCounts} merges them within a week; a column lacking a key reads 0.
 * Muscle rows sort by their total across columns (descending), then vocabulary order,
 * then code-unit order; pattern rows keep {@link MOVEMENT_PATTERN_ROWS} order. Uncounted
 * lifts are aligned the same way and sorted by total, heaviest first.
 */
export function toVolumeTable(columns: readonly WeeklyVolume[], order: VolumeRowOrder): VolumeTable {
  const rows = new Map<string, VolumeTableRow>();
  const uncounted = new Map<string, { lift: string; sets: number[] }>();

  columns.forEach((column, i) => {
    for (const count of column.counts) {
      const id = count.key.toLowerCase();
      const row = rows.get(id) ?? { key: count.key, sets: columns.map(() => 0) };
      row.sets[i] = (row.sets[i] ?? 0) + count.sets;
      rows.set(id, row);
    }
    for (const lift of column.uncounted) {
      const row = uncounted.get(lift.lift) ?? { lift: lift.lift, sets: columns.map(() => 0) };
      row.sets[i] = (row.sets[i] ?? 0) + lift.sets;
      uncounted.set(lift.lift, row);
    }
  });

  const total = (sets: readonly number[]) => sets.reduce((sum, n) => sum + n, 0);
  const sortedRows = [...rows.values()].sort((a, b) =>
    order === 'muscle'
      ? compareMuscleRows({ key: a.key, total: total(a.sets) }, { key: b.key, total: total(b.sets) })
      : comparePatternRows(a, b),
  );
  const sortedUncounted = [...uncounted.values()].sort(
    (a, b) => total(b.sets) - total(a.sets) || byCodeUnit(a.lift, b.lift),
  );
  return { rows: sortedRows, uncounted: sortedUncounted };
}
