/**
 * Supplements (#1372): a stack of items, each dosed into slots on named day types.
 * Pure data shapes; the computation lives in packages/core/src/supplements.
 */

/** Slots tied to a workout; a dose in one must name at least one day type. */
export const WORKOUT_SLOTS = ['pre', 'intra', 'post'] as const;
/** Slots through the day (`all`) or at a time of day; no day types means every day. */
export const DAILY_SLOTS = ['all', 'am', 'noon', 'pm'] as const;
export const SUPPLEMENT_SLOTS = [...WORKOUT_SLOTS, ...DAILY_SLOTS] as const;

export type WorkoutSlot = (typeof WORKOUT_SLOTS)[number];
export type SupplementSlot = (typeof SUPPLEMENT_SLOTS)[number];

export const INGREDIENT_UNITS = ['mg', 'g', 'mcg'] as const;
export type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

export type SupplementStatus = 'active' | 'pending';

export interface SupplementDayType {
  id: string;
  name: string;
  /** Session start, 24-hour `HH:MM`. Absent on a rest day. */
  sessionTime?: string;
}

/** Amount of one ingredient in a single serving. */
export interface Ingredient {
  key: string;
  amount: number;
  unit: IngredientUnit;
}

/** One component of a mix, kept so the mix's totals still include it. */
export interface SupplementPart {
  name: string;
  ingredients: Ingredient[];
}

export interface SupplementDose {
  slot: SupplementSlot;
  /** Free text such as "1 scoop". Blank means the amount is not set. */
  amount: string;
  /** Servings taken per dose; multiplies the per-serving ingredients. */
  servings: number;
  /** Day types the dose applies on. */
  dayTypes: string[];
}

export interface SupplementItem {
  id: string;
  name: string;
  keyCompound: string;
  timing: string;
  shortNote: string;
  longNote: string;
  status: SupplementStatus;
  /** Not yet confirmed against its label; shown but not counted. */
  unverified: boolean;
  links: string[];
  /** Per serving. */
  ingredients: Ingredient[];
  /** Present on a mix: its ingredients come from the parts instead of `ingredients`. */
  parts?: SupplementPart[];
  doses: SupplementDose[];
}

/** Append-only history entry; `date` is `YYYY-MM-DD`. */
export type SupplementChange = { date: string } & (
  | { type: 'added'; item: SupplementItem }
  | { type: 'edited'; itemId: string; changes: Partial<Omit<SupplementItem, 'id'>> }
  | { type: 'moved'; itemId: string; doses: SupplementDose[] }
  | { type: 'started'; itemId: string }
  | { type: 'moved_to_pending'; itemId: string }
  | { type: 'removed'; itemId: string }
  | { type: 'restored'; itemId: string }
  | { type: 'confirmed'; itemId: string }
  | { type: 'mix_created'; mix: SupplementItem; partIds: string[] }
  | { type: 'folded_into_mix'; mixId: string; itemId: string }
);

export interface SupplementAdvisory {
  rule: string;
  itemIds: string[];
  message: string;
  /** Key of the reference the rule cites. */
  source: string;
}
