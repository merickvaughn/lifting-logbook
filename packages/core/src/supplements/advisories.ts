import type {
  SupplementAdvisory,
  SupplementDayType,
  SupplementItem,
} from '@lifting-logbook/types';
import { isWorkoutSlot, placements, type Placement } from './placements';
import {
  ingredientTotals,
  itemIngredients,
  totalOf,
  type IngredientTotal,
} from './totals';

/** Stimulants taken for a session starting after this time (24-hour) are flagged. */
export const CAFFEINE_CUTOFF_TIME = '14:00';
/** FDA cites ~400 mg/day as an amount not generally associated with adverse effects. */
export const CAFFEINE_ADVISORY_MG = 350;
/** NIH ODS adequate intake for potassium, adult men: 3,400 mg/day. */
export const POTASSIUM_ADVISORY_MG = 3400;

export interface AdvisoryContext {
  stack: readonly SupplementItem[];
  dayType: SupplementDayType;
  placements: Placement[];
  totals: IngredientTotal[];
}

/**
 * Specification pattern (Evans & Fowler): each rule is a named predicate over the day's
 * context that returns an advisory when it holds and null otherwise.
 */
export interface AdvisoryRule {
  name: string;
  evaluate(ctx: AdvisoryContext): SupplementAdvisory | null;
}

const contributors = (ctx: AdvisoryContext, key: string): string[] =>
  ctx.totals.find((t) => t.key === key)?.shares.filter((s) => s.amount > 0).map((s) => s.itemId) ??
  [];

const hasIngredient = (item: SupplementItem, ...keys: string[]): boolean =>
  itemIngredients(item).some((i) => keys.includes(i.key));

export const lateStimulant: AdvisoryRule = {
  name: 'lateStimulant',
  evaluate(ctx) {
    const time = ctx.dayType.sessionTime;
    if (!time || time <= CAFFEINE_CUTOFF_TIME) return null;
    const ids = ctx.placements
      .filter((p) => p.counted && isWorkoutSlot(p.dose.slot) && hasIngredient(p.item, 'caffeine'))
      .map((p) => p.item.id);
    if (ids.length === 0) return null;
    return {
      rule: 'lateStimulant',
      itemIds: [...new Set(ids)],
      message: `Caffeine around a ${time} session (cutoff ${CAFFEINE_CUTOFF_TIME}) can cut into sleep.`,
      source: 'fda-caffeine',
    };
  },
};

export const highCaffeine: AdvisoryRule = {
  name: 'highCaffeine',
  evaluate(ctx) {
    if (totalOf(ctx.totals, 'caffeine', 'mg') < CAFFEINE_ADVISORY_MG) return null;
    return {
      rule: 'highCaffeine',
      itemIds: contributors(ctx, 'caffeine'),
      message: `Caffeine totals ${CAFFEINE_ADVISORY_MG} mg or more; FDA cites about 400 mg/day as the reference.`,
      source: 'fda-caffeine',
    };
  },
};

export const highPotassium: AdvisoryRule = {
  name: 'highPotassium',
  evaluate(ctx) {
    if (totalOf(ctx.totals, 'potassium', 'mg') <= POTASSIUM_ADVISORY_MG) return null;
    return {
      rule: 'highPotassium',
      itemIds: contributors(ctx, 'potassium'),
      message: `Supplemental potassium is above ${POTASSIUM_ADVISORY_MG} mg (NIH ODS adequate intake); spreading it through the day is fine.`,
      source: 'nih-ods-potassium',
    };
  },
};

/** The Night slot is `pm`. */
export const adaptogenAtNight: AdvisoryRule = {
  name: 'adaptogenAtNight',
  evaluate(ctx) {
    const ids = ctx.placements
      .filter((p) => p.dose.slot === 'pm' && hasIngredient(p.item, 'ashwagandha', 'maca'))
      .map((p) => p.item.id);
    if (ids.length === 0) return null;
    return {
      rule: 'adaptogenAtNight',
      itemIds: [...new Set(ids)],
      message: 'Ashwagandha and maca are usually taken earlier in the day; at night they may disturb sleep.',
      source: 'adaptogen-timing',
    };
  },
};

export const missingAmount: AdvisoryRule = {
  name: 'missingAmount',
  evaluate(ctx) {
    const ids = ctx.placements.filter((p) => p.dose.amount.trim() === '').map((p) => p.item.id);
    if (ids.length === 0) return null;
    return {
      rule: 'missingAmount',
      itemIds: [...new Set(ids)],
      message: 'A dose has no amount, so it adds nothing to the totals.',
      source: 'stack-data',
    };
  },
};

export const ADVISORY_RULES: readonly AdvisoryRule[] = [
  lateStimulant,
  highCaffeine,
  highPotassium,
  adaptogenAtNight,
  missingAmount,
];

export function advisories(
  stack: readonly SupplementItem[],
  dayType: SupplementDayType,
  rules: readonly AdvisoryRule[] = ADVISORY_RULES,
): SupplementAdvisory[] {
  const ctx: AdvisoryContext = {
    stack,
    dayType,
    placements: placements(stack, dayType.id),
    totals: ingredientTotals(stack, dayType.id),
  };
  return rules.flatMap((r) => r.evaluate(ctx) ?? []);
}

