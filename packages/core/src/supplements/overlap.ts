import type { SupplementItem } from '@lifting-logbook/types';
import { isWorkoutSlot } from './placements';
import { convertAmount, itemIngredients } from './totals';

export interface Overlap {
  item: SupplementItem;
  sharedIngredients: string[];
  /** Same slot and, for a workout slot, a shared day type. */
  sameSlot: boolean;
  /** Same slot, and the candidate supplies at least as much of every shared ingredient. */
  preselect: boolean;
}

/** Amount (mg) of one ingredient the item supplies in a slot, summed over its matching doses. */
function slotAmountMg(
  item: SupplementItem,
  key: string,
  match: (dose: SupplementItem['doses'][number]) => boolean,
): number {
  const perServing = itemIngredients(item)
    .filter((i) => i.key === key)
    .reduce((sum, i) => sum + convertAmount(i.amount, i.unit, 'mg'), 0);
  return item.doses.filter(match).reduce((sum, d) => sum + perServing * d.servings, 0);
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

    const sameSlotDoses = (c: SupplementItem['doses'][number]) =>
      item.doses.some(
        (d) =>
          d.slot === c.slot &&
          (!isWorkoutSlot(c.slot) || d.dayTypes.some((t) => c.dayTypes.includes(t))),
      );
    const sameSlot = candidate.doses.some(sameSlotDoses);
    const preselect =
      sameSlot &&
      shared.every((key) => {
        const mine = slotAmountMg(candidate, key, sameSlotDoses);
        const theirs = slotAmountMg(item, key, (d) =>
          candidate.doses.some(
            (c) =>
              c.slot === d.slot &&
              (!isWorkoutSlot(c.slot) || d.dayTypes.some((t) => c.dayTypes.includes(t))),
          ),
        );
        return mine >= theirs;
      });
    out.push({ item, sharedIngredients: shared, sameSlot, preselect });
  }
  return out;
}
