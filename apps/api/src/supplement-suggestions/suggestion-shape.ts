import {
  INGREDIENT_UNITS,
  SUPPLEMENT_TEXT_MAX,
  type Ingredient,
  type IngredientUnit,
  type SupplementSuggestionSource,
} from '@lifting-logbook/types';

/** The most ingredients and sources a suggestion keeps. */
export const MAX_INGREDIENTS = 12;
export const MAX_SOURCES = 3;
/** The largest amount kept: a per-serving figure above this is a misread unit, not a dose. */
const MAX_AMOUNT = 1_000_000;

/** Text clipped to `max` characters, with control characters turned into spaces and runs of space folded. */
export function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** `Vitamin B6 (as pyridoxine)` as `vitamin-b6-as-pyridoxine`: the form ingredient keys take. */
export function ingredientKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** One ingredient, or null when its key is empty, its unit isn't one the app counts, or its amount isn't a sensible number. */
export function cleanIngredient(key: unknown, amount: unknown, unit: unknown): Ingredient | null {
  const k = typeof key === 'string' ? ingredientKey(key) : '';
  if (k === '' || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  if (typeof unit !== 'string' || !(INGREDIENT_UNITS as readonly string[]).includes(unit)) return null;
  return { key: k, amount, unit: unit as IngredientUnit };
}

/** A source kept only when its URL is https with a dotted host and no credentials. */
export function httpsSource(label: unknown, url: unknown): SupplementSuggestionSource | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null; // not a URL: dropped, like an http one
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.') || parsed.username !== '' || parsed.password !== '') return null;
  return { label: clip(label, SUPPLEMENT_TEXT_MAX.linkLabel) || parsed.hostname, url: parsed.toString() };
}
