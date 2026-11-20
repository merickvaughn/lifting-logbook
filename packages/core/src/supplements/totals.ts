import type { Ingredient, IngredientUnit, SupplementItem } from '@lifting-logbook/types';
import { placements, type Placement } from './placements';

const MG_PER_UNIT: Record<IngredientUnit, number> = { mg: 1, g: 1000, mcg: 0.001 };

export function convertAmount(amount: number, from: IngredientUnit, to: IngredientUnit): number {
  return (amount * MG_PER_UNIT[from]) / MG_PER_UNIT[to];
}

export interface IngredientShare {
  itemId: string;
  /** In the total's unit. */
  amount: number;
}

export interface IngredientTotal {
  key: string;
  /** The unit of the first contribution seen; later ones are converted to it. */
  unit: IngredientUnit;
  total: number;
  shares: IngredientShare[];
}

/** Per-serving ingredients of an item; a mix contributes its parts' ingredients. */
export function itemIngredients(item: SupplementItem): Ingredient[] {
  return item.parts ? item.parts.flatMap((p) => p.ingredients) : item.ingredients;
}

/** A dose with a blank amount contributes nothing. */
export function servingsTaken(p: Placement): number {
  return p.dose.amount.trim() === '' ? 0 : p.dose.servings;
}

/** Sums each ingredient as amount × servings across counted placements. */
export function ingredientTotals(
  stack: readonly SupplementItem[],
  dayTypeId: string,
): IngredientTotal[] {
  const totals = new Map<string, IngredientTotal>();
  for (const p of placements(stack, dayTypeId)) {
    if (!p.counted) continue;
    const servings = servingsTaken(p);
    for (const ing of itemIngredients(p.item)) {
      let t = totals.get(ing.key);
      if (!t) {
        t = { key: ing.key, unit: ing.unit, total: 0, shares: [] };
        totals.set(ing.key, t);
      }
      const amount = convertAmount(ing.amount, ing.unit, t.unit) * servings;
      t.total += amount;
      const share = t.shares.find((s) => s.itemId === p.item.id);
      if (share) share.amount += amount;
      else t.shares.push({ itemId: p.item.id, amount });
    }
  }
  return [...totals.values()];
}

/** The day's total of one ingredient in `unit`; 0 when absent. */
export function totalOf(
  totals: readonly IngredientTotal[],
  key: string,
  unit: IngredientUnit,
): number {
  const t = totals.find((x) => x.key === key);
  return t ? convertAmount(t.total, t.unit, unit) : 0;
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
