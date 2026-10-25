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

/** A record's own value for `key` — never one inherited from `Object.prototype`. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** True when a `rule` entry's lift is planned today, so the rule keeps it out. */
function ruleExcludes(entry: FocusPoolEntry, plannedLifts: readonly string[]): boolean {
  return entry.include === 'rule' && entry.ruleLift !== '' && plannedLifts.includes(entry.ruleLift);
}

/**
 * Picks a block's lifts for one workout.
 *
 * Include rules run first: `off` and `swap` lifts are never selected directly, and a `rule`
 * lift drops out when its `ruleLift` is planned. The selection mode then chooses among the
 * rest, with `always` lifts on top of `rotate`, `fixed` and `pick`. Last, when a planned
 * lift's primary muscles train the area, the overlap mode applies: Skip drops everything,
 * Reduce takes one set off each lift (never below 1), Swap replaces each lift with its
 * `swapTo` (keeping the first of any duplicates, and keeping the original when the target
 * is `off` or excluded by its own rule today), and Do it anyway changes nothing.
 *
 * Rotate picks the flex lift at `rotationIndex` modulo the flex count. Pass a counter that
 * keeps increasing across weeks — the workout's number since the block started — so a pool
 * larger than the workouts in a week still cycles through every lift. The workout's index
 * within its week repeats each week instead.
 *
 * Lift names are compared exactly; the caller passes planned lifts and pool lifts by name.
 */
export function selectForDay(
  block: FocusBlock,
  plannedLifts: readonly string[],
  rotationIndex: number,
  dayState: Pick<FocusDayState, 'modes' | 'picks'> | undefined,
  resolveMuscles: FocusMuscleResolver,
): FocusSelectionResult {
  const mode = own(dayState?.modes, block.id) ?? block.selection;
  const overlapBy = [...new Set(plannedLifts.filter((lift) => trainsArea(lift, block.area, resolveMuscles)))];
  const skipped: FocusSkippedLift[] = [];
  const eligible: FocusPoolEntry[] = [];
  let suggestions: FocusPoolEntry[] = [];

  for (const entry of block.pool) {
    if (entry.include === 'off' || entry.include === 'swap') continue;
    if (ruleExcludes(entry, plannedLifts)) {
      skipped.push({ lift: entry.lift, reason: 'rule', detail: entry.ruleLift });
      continue;
    }
    eligible.push(entry);
  }

  const always = eligible.filter((entry) => entry.include === 'always');
  const flex = eligible.filter((entry) => entry.include !== 'always');
  let chosen: FocusPoolEntry[];
  switch (mode) {
    case 'rotate': {
      chosen = [...always];
      if (flex.length > 0) {
        const pick = flex[((rotationIndex % flex.length) + flex.length) % flex.length];
        for (const entry of flex) {
          if (entry === pick) chosen.push(entry);
          else skipped.push({ lift: entry.lift, reason: 'rotation', detail: '' });
        }
      }
      break;
    }
    case 'fixed': {
      chosen = [...always];
      const [first, ...rest] = flex;
      if (first) {
        chosen.push(first);
        for (const entry of rest) skipped.push({ lift: entry.lift, reason: 'fixed', detail: first.lift });
      }
      break;
    }
    case 'pick': {
      const picks = own(dayState?.picks, block.id) ?? [];
      chosen = eligible.filter((entry) => entry.include === 'always' || picks.includes(entry.lift));
      suggestions = flex;
      break;
    }
    case 'rules':
      chosen = eligible;
      break;
    default: {
      const unknown: never = mode;
      throw new Error(`Unknown focus selection mode: ${String(unknown)}`);
    }
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
      items = items.map((item) =>
        item.sets > 1 ? { ...item, sets: item.sets - 1, reducedFrom: item.sets } : item,
      );
    } else if (block.overlap === 'swap') {
      const seen = new Set<string>();
      items = items
        .map((item): FocusItem => {
          const target = block.pool.find((entry) => entry.lift === item.entry.swapTo);
          const usable = target && target.include !== 'off' && !ruleExcludes(target, plannedLifts);
          return usable
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
