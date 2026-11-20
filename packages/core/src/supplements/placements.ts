import {
  INGREDIENT_UNITS,
  WORKOUT_SLOTS,
  type Ingredient,
  type SupplementDayType,
  type SupplementDose,
  type SupplementItem,
  type SupplementSlot,
  type WorkoutSlot,
} from '@lifting-logbook/types';
import { isClockTime } from './clock';

export interface Placement {
  item: SupplementItem;
  dose: SupplementDose;
  /** False for pending and unverified items: shown, but left out of totals and advisories. */
  counted: boolean;
}

export function isWorkoutSlot(slot: SupplementSlot): slot is WorkoutSlot {
  return WORKOUT_SLOTS.some((s) => s === slot);
}

/** False when the dose's amount is blank: it is not set, so the dose contributes nothing. */
export function hasAmount(dose: SupplementDose): boolean {
  return dose.amount.trim() !== '';
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

function ingredientErrors(owner: string, ingredients: readonly Ingredient[]): string[] {
  const errors: string[] = [];
  for (const i of ingredients) {
    if (!Number.isFinite(i.amount) || i.amount < 0) {
      errors.push(`${owner}: ${i.key} amount must be a number, 0 or more`);
    }
    if (!INGREDIENT_UNITS.some((u) => u === i.unit)) {
      errors.push(`${owner}: ${i.key} unit "${i.unit}" is not one of ${INGREDIENT_UNITS.join(', ')}`);
    }
  }
  return errors;
}

/** Returns one message per problem; empty when the stack and its day types are valid. */
export function validateStack(
  stack: readonly SupplementItem[],
  dayTypes: readonly SupplementDayType[],
): string[] {
  const known = new Set(dayTypes.map((d) => d.id));
  const errors: string[] = [];
  for (const dayType of dayTypes) {
    if (dayType.sessionTime !== undefined && !isClockTime(dayType.sessionTime)) {
      errors.push(`${dayType.name}: session time "${dayType.sessionTime}" must be 24-hour HH:MM`);
    }
  }
  for (const item of stack) {
    errors.push(...ingredientErrors(item.name, item.ingredients));
    for (const part of item.parts ?? []) {
      errors.push(...ingredientErrors(`${item.name} (${part.name})`, part.ingredients));
    }
    for (const dose of item.doses) {
      if (isWorkoutSlot(dose.slot) && dose.dayTypes.length === 0) {
        errors.push(`${item.name}: a ${dose.slot} dose needs at least one day type`);
      }
      for (const id of dose.dayTypes) {
        if (!known.has(id)) errors.push(`${item.name}: unknown day type "${id}"`);
      }
      if (!Number.isFinite(dose.servings) || dose.servings < 0) {
        errors.push(`${item.name}: servings must be a number, 0 or more`);
      }
    }
  }
  return errors;
}
