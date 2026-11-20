import type {
  SupplementAdvisory,
  SupplementAdvisoryRule,
  SupplementDayType,
  SupplementItem,
} from '@lifting-logbook/types';
import { minutesOfDay } from './clock';
import { hasAmount, isWorkoutSlot, placements, type Placement } from './placements';
import {
  ingredientTotals,
  itemIngredients,
  toNanograms,
  totalNanograms,
  type IngredientTotal,
} from './totals';

/** Stimulants taken for a session starting after this time (24-hour) are flagged, unless the user sets another. */
export const DEFAULT_CAFFEINE_CUTOFF = '14:00';
/** FDA cites ~400 mg/day as an amount not generally associated with adverse effects. */
export const CAFFEINE_ADVISORY_MG = 350;
/** NIH ODS adequate intake for potassium, adult men: 3,400 mg/day. */
export const POTASSIUM_ADVISORY_MG = 3400;

export interface AdvisoryOptions {
  /** 24-hour `HH:MM`; defaults to `DEFAULT_CAFFEINE_CUTOFF`. */
  caffeineCutoff?: string;
}

/**
 * What every rule sees for one day type. Advisories cover only counted items: `placements`
 * and `totals` both leave out pending and unverified items, so no rule decides that itself.
 */
export interface AdvisoryContext {
  dayType: SupplementDayType;
  /** 24-hour `HH:MM`. */
  caffeineCutoff: string;
  /** Counted placements only. */
  placements: Placement[];
  /** Built from counted placements only. */
  totals: IngredientTotal[];
}

/**
 * Specification pattern (Evans & Fowler): each rule is a named predicate over the day's
 * context that returns an advisory when it holds and null otherwise.
 */
export interface AdvisoryRule {
  evaluate(ctx: AdvisoryContext): SupplementAdvisory | null;
}

/** Throws a RangeError when the cutoff or the day type's session time isn't 24-hour `HH:MM`. */
export function advisoryContext(
  stack: readonly SupplementItem[],
  dayType: SupplementDayType,
  options: AdvisoryOptions = {},
): AdvisoryContext {
  const caffeineCutoff = options.caffeineCutoff ?? DEFAULT_CAFFEINE_CUTOFF;
  minutesOfDay(caffeineCutoff);
  if (dayType.sessionTime !== undefined) minutesOfDay(dayType.sessionTime);
  return {
    dayType,
    caffeineCutoff,
    placements: placements(stack, dayType.id).filter((p) => p.counted),
    totals: ingredientTotals(stack, dayType.id),
  };
}

const contributors = (ctx: AdvisoryContext, key: string): string[] =>
  ctx.totals.find((t) => t.key === key)?.shares.filter((s) => s.ng > 0).map((s) => s.itemId) ??
  [];

const hasIngredient = (item: SupplementItem, ...keys: string[]): boolean =>
  itemIngredients(item).some((i) => keys.includes(i.key));

const flagged = (
  rule: SupplementAdvisoryRule,
  ids: readonly string[],
  advisory: Omit<SupplementAdvisory, 'rule' | 'itemIds'>,
): SupplementAdvisory | null => (ids.length === 0 ? null : { rule, itemIds: [...new Set(ids)], ...advisory });

export const lateStimulant: AdvisoryRule = {
  evaluate(ctx) {
    const time = ctx.dayType.sessionTime;
    if (time === undefined || minutesOfDay(time) <= minutesOfDay(ctx.caffeineCutoff)) return null;
    const ids = ctx.placements
      .filter((p) => isWorkoutSlot(p.dose.slot) && hasIngredient(p.item, 'caffeine'))
      .map((p) => p.item.id);
    return flagged('lateStimulant', ids, {
      message: `Caffeine around a ${time} session (cutoff ${ctx.caffeineCutoff}) can cut into sleep.`,
      source: 'fda-caffeine',
    });
  },
};

export const highCaffeine: AdvisoryRule = {
  evaluate(ctx) {
    if (totalNanograms(ctx.totals, 'caffeine') < toNanograms(CAFFEINE_ADVISORY_MG, 'mg')) return null;
    return flagged('highCaffeine', contributors(ctx, 'caffeine'), {
      message: `Caffeine totals ${CAFFEINE_ADVISORY_MG} mg or more; FDA cites about 400 mg/day as the reference.`,
      source: 'fda-caffeine',
    });
  },
};

export const highPotassium: AdvisoryRule = {
  evaluate(ctx) {
    if (totalNanograms(ctx.totals, 'potassium') <= toNanograms(POTASSIUM_ADVISORY_MG, 'mg')) return null;
    return flagged('highPotassium', contributors(ctx, 'potassium'), {
      message: `Supplemental potassium is above ${POTASSIUM_ADVISORY_MG} mg (NIH ODS adequate intake); spreading it through the day is fine.`,
      source: 'nih-ods-potassium',
    });
  },
};

/** The Night slot is `pm`. */
export const adaptogenAtNight: AdvisoryRule = {
  evaluate(ctx) {
    const ids = ctx.placements
      .filter((p) => p.dose.slot === 'pm' && hasIngredient(p.item, 'ashwagandha', 'maca'))
      .map((p) => p.item.id);
    return flagged('adaptogenAtNight', ids, {
      message: 'Ashwagandha and maca are usually taken earlier in the day; at night they may disturb sleep.',
      source: 'adaptogen-timing',
    });
  },
};

export const missingAmount: AdvisoryRule = {
  evaluate(ctx) {
    const ids = ctx.placements.filter((p) => !hasAmount(p.dose)).map((p) => p.item.id);
    return flagged('missingAmount', ids, {
      message: 'A dose has no amount, so it adds nothing to the totals.',
      source: 'stack-data',
    });
  },
};

export const ADVISORY_RULES: readonly AdvisoryRule[] = [
  lateStimulant,
  highCaffeine,
  highPotassium,
  adaptogenAtNight,
  missingAmount,
];

/** Every rule's advisory for the day type. Throws a RangeError on a malformed time (see `advisoryContext`). */
export function advisories(
  stack: readonly SupplementItem[],
  dayType: SupplementDayType,
  options: AdvisoryOptions = {},
): SupplementAdvisory[] {
  const ctx = advisoryContext(stack, dayType, options);
  return ADVISORY_RULES.flatMap((r) => r.evaluate(ctx) ?? []);
}
