import type { FocusBlock, FocusBudget, FocusDayState, FocusTimer } from '@lifting-logbook/types';
import { blockStatus } from './dates';
import { selectForDay, type FocusMuscleResolver, type FocusSelectionResult } from './select';

/** Seconds to run `sets` sets on a block's timer: prep and set each time, rest between. */
export function focusDurationSec(sets: number, timer: FocusTimer): number {
  return sets * (timer.prep + timer.set) + Math.max(0, sets - 1) * timer.rest;
}

/** A lift's share of focus time: its sets plus one rest to move on to the next lift. */
export function focusLiftCostSec(sets: number, timer: FocusTimer): number {
  return focusDurationSec(sets, timer) + timer.rest;
}

/** The key a trim is stored under in {@link FocusDayState.trims}. */
export function focusTrimKey(blockId: string, lift: string): string {
  return `${blockId}|${lift}`;
}

export interface FocusGroup {
  block: FocusBlock;
  /** Today's selection, with trimmed lifts removed from `items`. */
  selection: FocusSelectionResult;
  /** Lifts the user trimmed for today. */
  trimmed: string[];
}

/** What trimming the lowest-priority lift would bring the day to. */
export interface FocusTrimSuggestion {
  blockId: string;
  lift: string;
  sets: number;
  seconds: number;
}

export interface FocusDayPlan {
  groups: FocusGroup[];
  sets: number;
  seconds: number;
  /** Over the daily guide on sets or minutes. Advisory only. */
  over: boolean;
  suggestion: FocusTrimSuggestion | null;
}

export interface PlanFocusDayInput {
  blocks: readonly FocusBlock[];
  plannedLifts: readonly string[];
  /** The workout's index within its week, for rotation. */
  dayIndex: number;
  dayState?: Pick<FocusDayState, 'modes' | 'picks' | 'trims'>;
  budget: FocusBudget;
  today: Date;
  resolveMuscles: FocusMuscleResolver;
}

/**
 * Focus work for one workout: every block active on `today`, highest priority first, each
 * with its selection and the day's trims applied. When the totals are over the guide, the
 * suggestion is the last lift of the lowest-priority block that still has lifts.
 */
export function planFocusDay(input: PlanFocusDayInput): FocusDayPlan {
  const { blocks, plannedLifts, dayIndex, dayState, budget, today, resolveMuscles } = input;
  const trims = dayState?.trims ?? [];
  const groups: FocusGroup[] = blocks
    .filter((block) => blockStatus(block, today) === 'active')
    .sort((a, b) => a.priority - b.priority)
    .map((block) => {
      const selection = selectForDay(block, plannedLifts, dayIndex, dayState, resolveMuscles);
      const isTrimmed = (lift: string) => trims.includes(focusTrimKey(block.id, lift));
      return {
        block,
        selection: { ...selection, items: selection.items.filter((item) => !isTrimmed(item.lift)) },
        trimmed: selection.items.filter((item) => isTrimmed(item.lift)).map((item) => item.lift),
      };
    });

  let sets = 0;
  let seconds = 0;
  for (const group of groups) {
    for (const item of group.selection.items) {
      sets += item.sets;
      seconds += focusLiftCostSec(item.sets, group.block.timer);
    }
  }

  const over = sets > budget.sets || seconds / 60 > budget.minutes;
  let suggestion: FocusTrimSuggestion | null = null;
  if (over) {
    for (const { block, selection } of [...groups].reverse()) {
      const last = selection.items[selection.items.length - 1];
      if (last) {
        suggestion = {
          blockId: block.id,
          lift: last.lift,
          sets: sets - last.sets,
          seconds: seconds - focusLiftCostSec(last.sets, block.timer),
        };
        break;
      }
    }
  }

  return { groups, sets, seconds, over, suggestion };
}
