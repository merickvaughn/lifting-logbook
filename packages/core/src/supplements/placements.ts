import {
  WORKOUT_SLOTS,
  type SupplementDayType,
  type SupplementDose,
  type SupplementItem,
  type SupplementSlot,
} from '@lifting-logbook/types';

export interface Placement {
  item: SupplementItem;
  dose: SupplementDose;
  /** False for pending and unverified items: shown, but left out of totals. */
  counted: boolean;
}

export function isWorkoutSlot(slot: SupplementSlot): boolean {
  return (WORKOUT_SLOTS as readonly string[]).includes(slot);
}

/** True when the dose applies on the day type. A daily dose with no day types applies every day. */
export function doseAppliesOn(dose: SupplementDose, dayTypeId: string): boolean {
  if (dose.dayTypes.length === 0) return !isWorkoutSlot(dose.slot);
  return dose.dayTypes.includes(dayTypeId);
}

/** Every (item, dose) that applies on the day type. */
export function placements(stack: readonly SupplementItem[], dayTypeId: string): Placement[] {
  const out: Placement[] = [];
  for (const item of stack) {
    for (const dose of item.doses) {
      if (doseAppliesOn(dose, dayTypeId)) {
        out.push({ item, dose, counted: item.status === 'active' && !item.unverified });
      }
    }
  }
  return out;
}

/** Returns one message per problem; empty when the stack is valid. */
export function validateStack(
  stack: readonly SupplementItem[],
  dayTypes: readonly SupplementDayType[],
): string[] {
  const known = new Set(dayTypes.map((d) => d.id));
  const errors: string[] = [];
  for (const item of stack) {
    for (const dose of item.doses) {
      if (isWorkoutSlot(dose.slot) && dose.dayTypes.length === 0) {
        errors.push(`${item.name}: a ${dose.slot} dose needs at least one day type`);
      }
      for (const id of dose.dayTypes) {
        if (!known.has(id)) errors.push(`${item.name}: unknown day type "${id}"`);
      }
      if (!(dose.servings >= 0)) errors.push(`${item.name}: servings must be 0 or more`);
    }
  }
  return errors;
}
