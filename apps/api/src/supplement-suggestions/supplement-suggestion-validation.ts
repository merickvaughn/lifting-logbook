import { SUPPLEMENT_SLOTS, SUPPLEMENT_TEXT_MAX, type SupplementSlot, type SupplementSuggestion } from '@lifting-logbook/types';
import { MAX_INGREDIENTS, MAX_SOURCES, cleanIngredient, clip, httpsSource } from './suggestion-shape';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The AI's reply as a suggestion, or null when it isn't one: not JSON, not the schema's shape, no
 * name, or an explicit `null`. Text is clipped, ingredients with a bad unit or amount are dropped,
 * and only https sources are kept. Nothing it returns is trusted as verified; the form saves it
 * unverified.
 */
export function validateSupplementSuggestion(output: unknown): SupplementSuggestion | null {
  let reply = output;
  if (typeof reply === 'string') {
    try {
      reply = JSON.parse(reply);
    } catch {
      return null; // text instead of the JSON asked for
    }
  }
  if (!isRecord(reply) || !isRecord(reply.suggestion)) return null;
  const s = reply.suggestion;
  const name = clip(s.name, SUPPLEMENT_TEXT_MAX.name);
  if (name === '') return null;
  const slot = (SUPPLEMENT_SLOTS as readonly unknown[]).includes(s.suggestedSlot) ? (s.suggestedSlot as SupplementSlot) : 'all';
  const ingredients = (Array.isArray(s.ingredients) ? s.ingredients : [])
    .map((i: unknown) => (isRecord(i) ? cleanIngredient(i.key, i.amount, i.unit) : null))
    .filter((i): i is NonNullable<typeof i> => i !== null)
    .slice(0, MAX_INGREDIENTS);
  const sources = (Array.isArray(s.sources) ? s.sources : [])
    .map((x: unknown) => (isRecord(x) ? httpsSource(x.label, x.url) : null))
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, MAX_SOURCES);
  return {
    name,
    keyCompound: clip(s.keyCompound, SUPPLEMENT_TEXT_MAX.name),
    suggestedDose: clip(s.suggestedDose, SUPPLEMENT_TEXT_MAX.name),
    timing: clip(s.timing, SUPPLEMENT_TEXT_MAX.name),
    suggestedSlot: slot,
    typicalRange: clip(s.typicalRange, SUPPLEMENT_TEXT_MAX.name),
    ingredients,
    productType: '',
    sources,
  };
}
