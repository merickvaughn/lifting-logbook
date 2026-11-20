import type { Ingredient, IngredientUnit, SupplementItem } from '@lifting-logbook/types';
import { hasAmount, placements } from './placements';

/**
 * Amounts are summed as whole nanograms. Every unit is a whole number of them, and each
 * contribution is rounded once, so a sum is exact and a total compares exactly against a
 * threshold: 1.2 g + 2.2 g of potassium is 3,400 mg, not 3,400.0000000000005.
 */
const NG_PER_UNIT: Record<IngredientUnit, number> = { mcg: 1_000, mg: 1_000_000, g: 1_000_000_000 };

/** `amount` of `unit` as whole nanograms. */
export function toNanograms(amount: number, unit: IngredientUnit): number {
  return Math.round(amount * NG_PER_UNIT[unit]);
}

/** Whole nanograms in `unit`. */
export function fromNanograms(ng: number, unit: IngredientUnit): number {
  return ng / NG_PER_UNIT[unit];
}

export interface IngredientShare {
  itemId: string;
  /** Whole nanograms. */
  ng: number;
}

export interface IngredientTotal {
  key: string;
  /** Whole nanograms; `totalOf` reads it in a unit. */
  ng: number;
  shares: IngredientShare[];
}

/** Per-serving ingredients of an item; a mix contributes its parts' ingredients. */
export function itemIngredients(item: SupplementItem): Ingredient[] {
  return item.parts ? item.parts.flatMap((p) => p.ingredients) : item.ingredients;
}

/** Sums each ingredient as amount × servings across counted placements; a blank amount adds 0. */
export function ingredientTotals(
  stack: readonly SupplementItem[],
  dayTypeId: string,
): IngredientTotal[] {
  const totals = new Map<string, IngredientTotal>();
  for (const p of placements(stack, dayTypeId)) {
    if (!p.counted) continue;
    const servings = hasAmount(p.dose) ? p.dose.servings : 0;
    for (const ing of itemIngredients(p.item)) {
      let t = totals.get(ing.key);
      if (!t) {
        t = { key: ing.key, ng: 0, shares: [] };
        totals.set(ing.key, t);
      }
      const ng = Math.round(toNanograms(ing.amount, ing.unit) * servings);
      t.ng += ng;
      const share = t.shares.find((s) => s.itemId === p.item.id);
      if (share) share.ng += ng;
      else t.shares.push({ itemId: p.item.id, ng });
    }
  }
  return [...totals.values()];
}

/** Whole nanograms of one ingredient on the day; 0 when absent. */
export function totalNanograms(totals: readonly IngredientTotal[], key: string): number {
  return totals.find((x) => x.key === key)?.ng ?? 0;
}

/** The day's total of one ingredient in `unit`; 0 when absent. */
export function totalOf(
  totals: readonly IngredientTotal[],
  key: string,
  unit: IngredientUnit,
): number {
  return fromNanograms(totalNanograms(totals, key), unit);
}

/**
 * Grams of supplemental protein on the day. Only the `protein` ingredient counts: free amino
 * acids (citrulline, taurine, glycine) are not protein for intake targets. Protein targets
 * follow the ISSN position stand on protein and exercise (Jäger et al., 2017,
 * https://doi.org/10.1186/s12970-017-0177-8).
 */
export function supplementalProtein(stack: readonly SupplementItem[], dayTypeId: string): number {
  return totalOf(ingredientTotals(stack, dayTypeId), 'protein', 'g');
}
