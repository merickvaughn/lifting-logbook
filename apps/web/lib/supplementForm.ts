import {
  dosesShareSlot,
  findOverlaps,
  fromNanograms,
  ingredientTotals,
  isWorkoutSlot,
  itemIngredients,
  totalNanograms,
  type Overlap,
} from '@lifting-logbook/core';
import type { SupplementItemBody } from '@lifting-logbook/api-client';
import type {
  Ingredient,
  SupplementCatalogEntry,
  SupplementItem,
  SupplementSlot,
  SupplementStatus,
  SupplementSuggestion,
  SupplementSuggestionTier,
} from '@lifting-logbook/types';
import { linkHost, num, searchFor, type Stack } from './supplementsView';

/*
 * The Add/Edit supplement form's state and the rules that turn it into a request (#1409).
 * A dose row follows FHIR Dosage (timing slot, amount, and the days it applies on):
 * https://build.fhir.org/dosage.html
 */

/** A tier 2 or 3 suggestion, with which tier it came from. */
export interface TieredSuggestion {
  tier: Exclude<SupplementSuggestionTier, 'catalog'>;
  suggestion: SupplementSuggestion;
}

/**
 * A suggestion in the catalog's shape, so `autofill` and `candidateItem` treat it as they do an
 * entry. Its empty `key` is never sent: `toBody` links only a real catalog entry (#1381).
 */
export function suggestionEntry(s: SupplementSuggestion): SupplementCatalogEntry {
  return {
    key: '',
    name: s.name,
    aliases: [],
    kind: 'product',
    keyCompound: s.keyCompound,
    suggestedDose: s.suggestedDose,
    timing: s.timing,
    suggestedSlot: s.suggestedSlot,
    ingredients: s.ingredients,
    reference: { uses: [], evidence: { level: 'limited', reason: '' }, cautions: [], typicalRange: s.typicalRange, sources: [] },
  };
}

/** The fields catalog autofill can fill; a field the lifter has typed in is never overwritten. */
export type AutofillField = 'keyCompound' | 'slot' | 'amount' | 'typicalRange' | 'timing' | 'links';

export interface DoseRow {
  slot: SupplementSlot;
  amount: string;
  servings: string;
  dayTypes: string[];
}

export interface LinkRow {
  label: string;
  url: string;
  /** Still the suggested store search, so it follows the name until the lifter edits it. */
  auto: boolean;
}

export interface FormValues {
  name: string;
  keyCompound: string;
  doses: DoseRow[];
  typicalRange: string;
  status: SupplementStatus;
  timing: string;
  shortNote: string;
  protein: string;
  category: string;
  longNote: string;
  links: LinkRow[];
}

export const SHORT_NOTE_MAX = 80;

export const SLOT_OPTION_LABEL: Record<SupplementSlot, string> = {
  pre: 'Workout · pre-workout',
  intra: 'Workout · intra-workout',
  post: 'Workout · post-workout',
  all: 'Every day · throughout the day',
  am: 'Every day · morning',
  noon: 'Every day · afternoon',
  pm: 'Every day · night',
};

export type Preset = 'workout' | 'daily' | 'pending';

export const newDose = (dayTypeId: string): DoseRow => ({ slot: 'pre', amount: '', servings: '1', dayTypes: dayTypeId ? [dayTypeId] : [] });

const proteinOf = (item: SupplementItem): string => {
  const grams = item.ingredients.filter((i) => i.key === 'protein' && i.unit === 'g').reduce((n, i) => n + i.amount, 0);
  return grams > 0 ? String(grams) : '';
};

/** The form as each entry point opens it. */
export function presetValues(preset: Preset, dayTypeId: string): FormValues {
  const base: FormValues = {
    name: '', keyCompound: '', doses: [], typicalRange: '', status: 'active', timing: '', shortNote: '',
    protein: '', category: '', longNote: '', links: [],
  };
  return preset === 'workout'
    ? { ...base, doses: [newDose(dayTypeId)] }
    : { ...base, status: preset === 'pending' ? 'pending' : 'active', doses: [{ slot: 'am', amount: '', servings: '1', dayTypes: [] }] };
}

/**
 * The form `Replace with…` opens: an Add form whose first dose starts in the replaced item's first
 * dose slot and day types (the mockup's preset). An item with no dose falls back to the daily preset.
 */
export function replaceValues(item: SupplementItem, dayTypeId: string): FormValues {
  const first = item.doses[0];
  const base = presetValues(first && isWorkoutSlot(first.slot) ? 'workout' : 'daily', dayTypeId);
  return first ? { ...base, doses: [{ slot: first.slot, amount: '', servings: '1', dayTypes: [...first.dayTypes] }] } : base;
}

export function itemValues(item: SupplementItem): FormValues {
  return {
    name: item.name,
    keyCompound: item.keyCompound,
    doses: item.doses.map((d) => ({ slot: d.slot, amount: d.amount, servings: String(d.servings), dayTypes: [...d.dayTypes] })),
    typicalRange: item.typicalRange,
    status: item.status,
    timing: item.timing,
    shortNote: item.shortNote,
    protein: proteinOf(item),
    category: item.category,
    longNote: item.longNote,
    links: item.links.map((l) => ({ ...l, auto: false })),
  };
}

export const suggestedLinkRow = (stack: Stack, name: string): LinkRow => {
  const s = searchFor(stack, name);
  return { label: `Search ${s.store}`, url: s.url, auto: true };
};

/** The links with any still-suggested search row pointed at `name`. */
export const trackName = (stack: Stack, links: LinkRow[], name: string): LinkRow[] =>
  links.map((l) => (l.auto ? suggestedLinkRow(stack, name.trim() || 'supplement') : l));

export interface Autofilled {
  values: FormValues;
  /** The fields this pass filled. */
  filled: AutofillField[];
}

/**
 * Fills the fields the lifter hasn't typed in from a catalog match. Adding may re-slot the first
 * dose; editing fills only what is empty and never re-slots (ADR-046). A dose re-slotted into a
 * workout slot with no day type gets `dayTypeId`, the day the page shows, so the form stays
 * saveable; one moved out of a workout slot keeps its day types, as the mockup does.
 */
export function autofill(
  values: FormValues,
  typed: ReadonlySet<string>,
  entry: SupplementCatalogEntry,
  mode: 'add' | 'edit',
  stack: Stack,
  dayTypeId = '',
): Autofilled {
  const filled: AutofillField[] = [];
  const next: FormValues = { ...values, doses: values.doses.map((d) => ({ ...d })), links: [...values.links] };
  const canFill = (field: AutofillField, current: string) => !typed.has(field) && (mode === 'add' || current.trim() === '');
  const text = (field: 'keyCompound' | 'typicalRange' | 'timing', suggestion: string) => {
    if (suggestion !== '' && suggestion !== next[field] && canFill(field, next[field])) {
      next[field] = suggestion;
      filled.push(field);
    }
  };
  text('keyCompound', entry.keyCompound);
  text('typicalRange', entry.reference.typicalRange);
  text('timing', entry.timing);
  const first = next.doses[0];
  if (first) {
    if (mode === 'add' && !typed.has('slot') && first.slot !== entry.suggestedSlot) {
      first.slot = entry.suggestedSlot;
      if (isWorkoutSlot(first.slot) && first.dayTypes.length === 0 && dayTypeId !== '') first.dayTypes = [dayTypeId];
      filled.push('slot');
    }
    if (entry.suggestedDose !== '' && entry.suggestedDose !== first.amount && canFill('amount', first.amount)) {
      first.amount = entry.suggestedDose;
      filled.push('amount');
    }
  }
  if (!typed.has('links') && next.links.length === 0) {
    next.links = [suggestedLinkRow(stack, values.name.trim())];
    filled.push('links');
  }
  return { values: next, filled };
}

/** What stops the form being sent, or undefined. Checked before any request. */
export function validate(values: FormValues): string | undefined {
  if (values.name.trim() === '') return 'Name is required.';
  for (const d of values.doses) {
    const servings = Number(d.servings);
    if (d.servings.trim() === '' || !Number.isFinite(servings) || servings < 0) return 'Servings must be a number, 0 or more.';
    if (isWorkoutSlot(d.slot) && d.dayTypes.length === 0) return `Pick at least one day type for ${SLOT_OPTION_LABEL[d.slot]}.`;
  }
  // The API's `@IsUrl` also wants a dotted host name, so `https://localhost` is refused here too.
  const bad = values.links.find((l) => {
    const url = l.url.trim();
    return url !== '' && (/\s/.test(url) || !linkHost(url)?.includes('.'));
  });
  if (bad) return 'A product link must be a web address starting with http:// or https://.';
  const protein = values.protein.trim();
  if (protein !== '' && !(Number.isFinite(Number(protein)) && Number(protein) >= 0)) return 'Protein per serving must be a number, 0 or more.';
  return undefined;
}

/**
 * The request for `values`. Protein becomes the item's `protein` ingredient, alongside the
 * ingredients it already has (an edit) or the catalog entry's (an add). An edit sends it only when
 * it changed. An add sends it whenever the field has a value, so a typed 0 removes the catalog
 * entry's protein, while a blank field keeps it. A mix never sends it: its ingredients come from
 * its parts.
 */
export function toBody(
  values: FormValues,
  opts: { item?: SupplementItem; entry?: SupplementCatalogEntry; suggested?: TieredSuggestion },
): SupplementItemBody {
  const { item, suggested } = opts;
  // A suggestion's ingredients ride in the body like a catalog entry's, but it names no catalog key.
  const entry = opts.entry ?? (suggested && suggestionEntry(suggested.suggestion));
  const body: SupplementItemBody = {
    name: values.name.trim(),
    keyCompound: values.keyCompound.trim(),
    timing: values.timing.trim(),
    shortNote: values.shortNote.trim(),
    longNote: values.longNote.trim(),
    category: values.category.trim(),
    typicalRange: values.typicalRange.trim(),
    links: values.links.filter((l) => l.url.trim() !== '').map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
    status: values.status,
    doses: values.doses.map((d) => ({ slot: d.slot, amount: d.amount.trim(), servings: Number(d.servings), dayTypes: d.dayTypes })),
  };
  // Only an add links the catalog entry: the edit endpoint doesn't take `catalogKey`, and rejects it.
  if (opts.entry && !item) body.catalogKey = opts.entry.key;
  // An AI suggestion is saved unverified: shown, but not counted until the lifter confirms it (#1381).
  if (suggested?.tier === 'ai' && !item) body.unverified = true;
  const protein = Number(values.protein.trim() || 0);
  const base = item ? item.ingredients : entry?.ingredients ?? [];
  const changed = item ? protein !== Number(proteinOf(item) || 0) : values.protein.trim() !== '';
  if (!item?.parts && (changed || (suggested && !item))) body.ingredients = withProtein(base, protein);
  return body;
}

/** `base` with its protein replaced by `grams` per serving (none at 0). */
const withProtein = (base: readonly Ingredient[], grams: number): Ingredient[] => [
  ...base.filter((i) => i.key !== 'protein'),
  ...(grams > 0 ? [{ key: 'protein', amount: grams, unit: 'g' as const }] : []),
];

/** What the form would add, as a stack item, so the same overlap rule as the API's core can compare it. */
export function candidateItem(values: Pick<FormValues, 'doses' | 'status' | 'protein'>, entry?: SupplementCatalogEntry): SupplementItem {
  // The ingredients an add would send (see `toBody`): the entry's, with protein from the field when it has a value.
  const base = entry?.ingredients ?? [];
  const protein = values.protein.trim();
  return {
    id: '',
    name: '',
    keyCompound: '',
    timing: '',
    shortNote: '',
    longNote: '',
    category: '',
    typicalRange: '',
    links: [],
    status: values.status,
    unverified: false,
    ingredients: protein === '' ? base : withProtein(base, Number(protein) || 0),
    doses: values.doses.map((d) => {
      const servings = Number(d.servings);
      return { slot: d.slot, amount: d.amount.trim(), servings: Number.isFinite(servings) ? servings : 0, dayTypes: d.dayTypes };
    }),
  };
}

/** Stack items the candidate shares an ingredient with, same-slot ones first (stable otherwise). */
export const overlapsFor = (candidate: SupplementItem, items: readonly SupplementItem[]): Overlap[] =>
  findOverlaps(candidate, items).sort((a, b) => Number(b.sameSlot) - Number(a.sameSlot));

/** Whether the candidate takes a dose in a slot `item` also takes one in: core's rule for `SAME SLOT`. */
export const sharesSlotWith = (candidate: SupplementItem, item: SupplementItem): boolean =>
  candidate.doses.some((c) => item.doses.some((d) => dosesShareSlot(c, d)));

/**
 * How much of one ingredient the item gives on the day type, counted as the page's day totals are:
 * doses that apply that day and have an amount, summed in nanograms across units. It's shown in
 * the unit the item lists it in.
 */
const onDay = (item: SupplementItem, key: string, dayTypeId: string): string => {
  const unit = itemIngredients(item).find((i) => i.key === key)?.unit ?? 'mg';
  const ng = totalNanograms(ingredientTotals([{ ...item, status: 'active', unverified: false }], dayTypeId), key);
  return `${num(fromNanograms(ng, unit))} ${unit}`;
};

/** `Shares creatine (5 g now; 5 g in this)`: each shared ingredient on the day type, in the stack and in the candidate. */
export const sharesLine = (o: Overlap, candidate: SupplementItem, dayTypeId: string): string => {
  const amounts = (item: SupplementItem) => o.sharedIngredients.map((k) => onDay(item, k, dayTypeId)).join(', ');
  return `Shares ${o.sharedIngredients.join(', ')} (${amounts(o.item)} now; ${amounts(candidate)} in this)`;
};

/** How the lifter wants the items a new one replaces dealt with. */
export type ReplaceHow = 'pending' | 'remove';
