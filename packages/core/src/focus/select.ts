import {
  FOCUS_AREA_MUSCLES,
  type FocusArea,
  type FocusBlock,
  type FocusDayState,
  type FocusOverlap,
  type FocusPoolEntry,
  type FocusSelection,
} from '@lifting-logbook/types';
import type { ResolvedMuscleTargets } from '../catalog/muscles';

/** Lift name → muscles. Built by `buildMuscleTargetResolver`, so user overrides apply. */
export type FocusMuscleResolver = (lift: string) => Pick<ResolvedMuscleTargets, 'primary'>;

/** Why a pool lift is not done today. */
export type FocusSkipReason = 'rule' | 'rotation' | 'fixed' | 'overlap';

export interface FocusSkippedLift {
  lift: string;
  reason: FocusSkipReason;
  /**
   * `rule`: the planned lift that triggered the rule. `fixed`: the lift fixed mode uses.
   * `overlap`: the planned lifts that train the area, joined with " & ". `rotation`: empty.
   */
  detail: string;
}

/** A focus lift selected for today. */
export interface FocusItem {
  entry: FocusPoolEntry;
  lift: string;
  sets: number;
  /** Set count before an overlap Reduce took one off. */
  reducedFrom?: number;
  /** The pool lift an overlap Swap replaced. */
  swappedFrom?: string;
}

/** The planned lifts that train a block's area, and how the block responds. */
export interface FocusOverlapInfo {
  lifts: string[];
  mode: FocusOverlap;
}

export interface FocusSelectionResult {
  items: FocusItem[];
  skipped: FocusSkippedLift[];
  /** In `pick` mode, the lifts offered to choose from. Empty otherwise. */
  suggestions: FocusPoolEntry[];
  overlap: FocusOverlapInfo | null;
  /** The selection mode used today: the day's override, or the block's own. */
  mode: FocusSelection;
}

/** True when one of the lift's primary muscles is in the area. */
export function trainsArea(lift: string, area: FocusArea, resolveMuscles: FocusMuscleResolver): boolean {
  const groups: readonly string[] = FOCUS_AREA_MUSCLES[area];
  return resolveMuscles(lift).primary.some((muscle) => groups.includes(muscle));
}

/**
 * Picks a block's lifts for one workout.
 *
 * Include rules run first: `off` and `swap` lifts are never selected directly, and a `rule`
 * lift drops out when its `ruleLift` is planned. The selection mode then chooses among the
 * rest, with `always` lifts on top of `rotate`, `fixed` and `pick`. Rotation cycles by
 * `dayIndex`, the workout's index within the week. Last, when a planned lift trains the
 * area, the overlap mode applies: Skip drops everything, Reduce takes one set off each
 * lift (never below 1), Swap replaces each lift with its `swapTo` (keeping the first of any
 * duplicates), and Do it anyway changes nothing.
 */
export function selectForDay(
  block: FocusBlock,
  plannedLifts: readonly string[],
  dayIndex: number,
  dayState: Pick<FocusDayState, 'modes' | 'picks'> | undefined,
  resolveMuscles: FocusMuscleResolver,
): FocusSelectionResult {
  const mode = dayState?.modes[block.id] ?? block.selection;
  const overlapBy = plannedLifts.filter((lift) => trainsArea(lift, block.area, resolveMuscles));
  const skipped: FocusSkippedLift[] = [];
  const eligible: FocusPoolEntry[] = [];
  let suggestions: FocusPoolEntry[] = [];

  for (const entry of block.pool) {
    if (entry.include === 'off' || entry.include === 'swap') continue;
    if (entry.include === 'rule' && entry.ruleLift && plannedLifts.includes(entry.ruleLift)) {
      skipped.push({ lift: entry.lift, reason: 'rule', detail: entry.ruleLift });
      continue;
    }
    eligible.push(entry);
  }

  const always = eligible.filter((entry) => entry.include === 'always');
  const flex = eligible.filter((entry) => entry.include !== 'always');
  let chosen: FocusPoolEntry[];
  if (mode === 'rotate') {
    chosen = [...always];
    // Undefined when the pool has no flex lifts (the index is NaN).
    const pick = flex[((dayIndex % flex.length) + flex.length) % flex.length];
    if (pick) {
      chosen.push(pick);
      for (const entry of flex) {
        if (entry !== pick) skipped.push({ lift: entry.lift, reason: 'rotation', detail: '' });
      }
    }
  } else if (mode === 'fixed') {
    chosen = [...always];
    const [first, ...rest] = flex;
    if (first) {
      chosen.push(first);
      for (const entry of rest) skipped.push({ lift: entry.lift, reason: 'fixed', detail: first.lift });
    }
  } else if (mode === 'pick') {
    const picks = dayState?.picks[block.id] ?? [];
    chosen = eligible.filter((entry) => entry.include === 'always' || picks.includes(entry.lift));
    suggestions = flex;
  } else {
    chosen = eligible;
  }

  let items: FocusItem[] = chosen.map((entry) => ({ entry, lift: entry.lift, sets: entry.sets }));
  let overlap: FocusOverlapInfo | null = null;
  if (overlapBy.length > 0) {
    overlap = { lifts: overlapBy, mode: block.overlap };
    const who = overlapBy.join(' & ');
    if (block.overlap === 'skip') {
      for (const item of items) skipped.push({ lift: item.lift, reason: 'overlap', detail: who });
      items = [];
    } else if (block.overlap === 'reduce') {
      items = items.map((item) => ({ ...item, sets: Math.max(1, item.sets - 1), reducedFrom: item.sets }));
    } else if (block.overlap === 'swap') {
      const seen = new Set<string>();
      items = items
        .map((item): FocusItem => {
          const target = item.entry.swapTo
            ? block.pool.find((entry) => entry.lift === item.entry.swapTo)
            : undefined;
          return target
            ? { entry: target, lift: target.lift, sets: target.sets, swappedFrom: item.lift }
            : item;
        })
        .filter((item) => {
          if (seen.has(item.lift)) return false;
          seen.add(item.lift);
          return true;
        });
    }
  }

  return { items, skipped, suggestions, overlap, mode };
}
