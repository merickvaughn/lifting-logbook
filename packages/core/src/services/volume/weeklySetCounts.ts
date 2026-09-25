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
 * The generic counter behind every weekly volume breakdown: groups `slots` by week
 * (ascending) and adds `sets × weight` to each row the lift's credits name.
 *
 * Rows merge case-insensitively under the first spelling seen, so a user's legacy
 * "quads" tag and a default "Quads" land in one row. A lift whose credits are undefined
 * or empty is reported in `uncounted` instead. A slot whose `sets` is not a positive
 * finite number — a program editor mid-keystroke — contributes nothing.
 *
 * `counts` come back in first-seen order; the named wrappers below sort for display.
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
    if (!Number.isFinite(slot.sets) || slot.sets <= 0) continue;
    let week = weeks.get(slot.week);
    if (!week) {
      week = { counts: new Map(), uncounted: new Map() };
      weeks.set(slot.week, week);
    }

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

/**
 * Weekly sets per muscle group. Rows sort by sets (descending), then vocabulary order,
 * then alphabetically for free-text labels, so the heaviest-trained muscles lead.
 */
export function weeklySetsByMuscleGroup(
  slots: readonly VolumeSlot[],
  targetsFor: (lift: string) => ResolvedMuscleTargets,
): WeeklyVolume[] {
  return weeklySetCounts(slots, (lift) => muscleCredits(targetsFor(lift))).map((week) => ({
    ...week,
    counts: [...week.counts].sort(
      (a, b) =>
        b.sets - a.sets ||
        rankIn(MUSCLE_GROUPS, a.key) - rankIn(MUSCLE_GROUPS, b.key) ||
        a.key.localeCompare(b.key),
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
  ).map((week) => ({
    ...week,
    counts: [...week.counts].sort(
      (a, b) => rankIn(MOVEMENT_PATTERN_ROWS, a.key) - rankIn(MOVEMENT_PATTERN_ROWS, b.key),
    ),
  }));
}

/** `3` → "3", `1.5` → "1.5". Counts are multiples of ½, so one decimal is exact. */
export function formatSetCount(sets: number): string {
  const rounded = Math.round(sets * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A run of weeks whose breakdowns are identical, shown as one column. */
export interface VolumeColumn {
  weeks: number[];
  volume: WeeklyVolume;
}

/**
 * Merges weeks with identical counts into one column, in first-appearance order — so a
 * program whose every week matches (5-3-1's three weeks, a one-week preset) renders a
 * single "sets / week" column instead of repeating it.
 */
export function collapseIdenticalWeeks(weeks: readonly WeeklyVolume[]): VolumeColumn[] {
  const signature = (week: WeeklyVolume) =>
    JSON.stringify([
      [...week.counts].map((c) => [c.key.toLowerCase(), c.sets]).sort(),
      [...week.uncounted].map((u) => [u.lift, u.sets]).sort(),
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
