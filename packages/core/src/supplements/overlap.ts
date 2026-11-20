import type { SupplementDose, SupplementItem } from '@lifting-logbook/types';
import { isWorkoutSlot } from './placements';
import { itemIngredients, toNanograms } from './totals';

export interface Overlap {
  item: SupplementItem;
  sharedIngredients: string[];
  /** Same slot and, for a workout slot, a shared day type. */
  sameSlot: boolean;
  /** Same slot, and the candidate supplies at least as much of every shared ingredient. */
  preselect: boolean;
}

/** Whole nanograms of one ingredient the item supplies in a slot, summed over its matching doses. */
function slotAmountNg(
  item: SupplementItem,
  key: string,
  match: (dose: SupplementDose) => boolean,
): number {
  const perServing = itemIngredients(item)
    .filter((i) => i.key === key)
    .reduce((sum, i) => sum + toNanograms(i.amount, i.unit), 0);
  return item.doses.filter(match).reduce((sum, d) => sum + Math.round(perServing * d.servings), 0);
}

/**
 * Active items in `stack` sharing an ingredient with `candidate`, for the replace prompt.
 * Only same-slot items the candidate matches or exceeds are pre-selected.
 */
export function findOverlaps(
  candidate: SupplementItem,
  stack: readonly SupplementItem[],
): Overlap[] {
  const candidateKeys = new Set(itemIngredients(candidate).map((i) => i.key));
  const out: Overlap[] = [];
  for (const item of stack) {
    if (item.status !== 'active' || item.id === candidate.id) continue;
    const shared = [...new Set(itemIngredients(item).map((i) => i.key))].filter((k) =>
      candidateKeys.has(k),
    );
    if (shared.length === 0) continue;

    const sharesSlot = (a: SupplementDose, b: SupplementDose) =>
      a.slot === b.slot &&
      (!isWorkoutSlot(a.slot) || a.dayTypes.some((t) => b.dayTypes.includes(t)));
    const candidateInSlot = (c: SupplementDose) => item.doses.some((d) => sharesSlot(c, d));
    const itemInSlot = (d: SupplementDose) => candidate.doses.some((c) => sharesSlot(c, d));
    const sameSlot = candidate.doses.some(candidateInSlot);
    const preselect =
      sameSlot &&
      shared.every(
        (key) =>
          slotAmountNg(candidate, key, candidateInSlot) >= slotAmountNg(item, key, itemInSlot),
      );
    out.push({ item, sharedIngredients: shared, sameSlot, preselect });
  }
  return out;
}
