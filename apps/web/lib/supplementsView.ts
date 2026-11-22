import {
  advisories,
  advisoryCoversDose,
  doseAppliesOn,
  fromNanograms,
  hasAmount,
  ingredientTotals,
  isWorkoutSlot,
  itemIngredients,
  placements,
  toNanograms,
  totalOf,
  type Placement,
} from '@lifting-logbook/core';
import type {
  IngredientUnit,
  SupplementAdvisoryRule,
  SupplementDayType,
  SupplementItem,
  SupplementSlot,
  SupplementStackResponse,
} from '@lifting-logbook/types';

/** What the page needs from `GET /supplements`; the totals and advisories come from `@lifting-logbook/core`. */
export type Stack = SupplementStackResponse;

export const SLOT_LABEL: Record<SupplementSlot, string> = {
  pre: 'Pre-workout',
  intra: 'Intra-workout',
  post: 'Post-workout',
  all: 'Throughout the day',
  am: 'Morning',
  noon: 'Afternoon',
  pm: 'Night',
};

export const WORKOUT_ORDER: SupplementSlot[] = ['pre', 'intra', 'post'];
export const DAILY_ORDER: SupplementSlot[] = ['all', 'am', 'noon', 'pm'];

/** `16:30` as `4:30 PM`; anything that isn't 24-hour `HH:MM` is shown as it is. */
export function clock12(hhmm: string): string {
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** At most one decimal, with thousands separators: `387.5`, `3,400`. */
export function num(n: number): string {
  return Number(n.toFixed(1)).toLocaleString('en-US');
}

/** `vitamin-b6` as `Vitamin b6`. */
export function ingredientName(key: string): string {
  const spaced = key.replace(/[-_]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const lc = (s: string) => s.toLowerCase();

/** One line of an advisory, in the page's own words. The message in core is generic. */
export interface AdvisoryNote {
  rule: SupplementAdvisoryRule;
  /** The one line under a row; the panel's callout opens with it. */
  line: string;
  /** The plain explanation after the line in the detail panel. */
  explanation: string;
}

export interface RowModel {
  key: string;
  item: SupplementItem;
  /** The slot of the dose this row shows (a pending row shows its first dose); none for an item with no dose. */
  slot?: SupplementSlot;
  /** Where that dose sits in `item.doses`, so a bulk move names exactly this dose (#1410). */
  doseIndex?: number;
  amount: string;
  /** The typical range, shown after the dose when the item has one dose. */
  range?: string;
  protein?: string;
  /** Line 2: key compound · timing. */
  detail: string;
  note: string;
  /** The other slots the item is dosed in on this day type. */
  also: string[];
  /** False for unverified items: shown, but left out of totals, so the row says so. */
  counted: boolean;
  advisories: AdvisoryNote[];
}

export interface SupplementsView {
  /** The selected day type, or `NO_DAY_TYPE` when the lifter has none yet. */
  dayType: SupplementDayType;
  activeCount: number;
  flaggedCount: number;
  protein: { total: string; contributors: string; others: string[] };
  workout: { sessionLine: string; count: number; slots: { slot: SupplementSlot; rows: RowModel[] }[] };
  daily: { count: number; slots: { slot: SupplementSlot; rows: RowModel[] }[] };
  pending: RowModel[];
  /** Active items with no dose that applies on any day type, so they'd show nowhere else. */
  unscheduled: RowModel[];
  /** Per item, for the detail panel. */
  notesByItem: Map<string, AdvisoryNote[]>;
  /** Set when core couldn't work out the advisories (a malformed time); the page shows the rest. */
  advisoryError?: unknown;
}

/** Stands in for a day type when the lifter has none: only daily doses with no day types apply. */
export const NO_DAY_TYPE: SupplementDayType = { id: '', name: 'Every day' };

function proteinGrams(item: SupplementItem, servings: number): number {
  const ng = itemIngredients(item)
    .filter((i) => i.key === 'protein')
    .reduce((sum, i) => sum + toNanograms(i.amount, i.unit), 0);
  return fromNanograms(Math.round(ng * servings), 'g');
}

type Dose = SupplementItem['doses'][number];

const dayTypeNames = (dose: Dose, dayTypes: readonly SupplementDayType[]): string[] =>
  dose.dayTypes.map((id) => dayTypes.find((d) => d.id === id)?.name ?? id);

/** `Pre-workout (Lift day)`, `Morning (Rest day)` for a daily dose limited to a day type, or `Morning`. */
export function placementText(dose: Dose, dayTypes: readonly SupplementDayType[]): string {
  const names = dayTypeNames(dose, dayTypes);
  return names.length > 0 ? `${SLOT_LABEL[dose.slot]} (${names.join(', ')})` : SLOT_LABEL[dose.slot];
}

/** Line 2 without the placement: the compound is left out when it only repeats the name. */
function detailLine(item: SupplementItem): string[] {
  const compound = item.keyCompound.trim();
  return [compound && lc(compound) !== lc(item.name.trim()) ? compound : '', item.timing.trim()].filter(Boolean);
}

function notesFor(stack: Stack, dayType: SupplementDayType): Map<string, AdvisoryNote[]> {
  const out = new Map<string, AdvisoryNote[]>();
  const totals = ingredientTotals(stack.items, dayType.id);
  const cutoff = clock12(stack.caffeineCutoff);
  const copy: Record<SupplementAdvisoryRule, Omit<AdvisoryNote, 'rule'>> = {
    lateStimulant: {
      line: `Stimulant at ${dayType.sessionTime ? clock12(dayType.sessionTime) : 'a late session'}, after your ${cutoff} caffeine cutoff`,
      explanation:
        'This lands late enough to affect sleep. If falling asleep slips, a stim-free pre-workout on late sessions is the easy swap.',
    },
    highCaffeine: {
      line: `~${Math.round(totalOf(totals, 'caffeine', 'mg'))} mg caffeine from supplements ${dayType === NO_DAY_TYPE ? 'a day' : `on ${lc(dayType.name)}s`}`,
      explanation:
        'FDA uses ~400 mg/day as the amount not generally linked to negative effects in healthy adults. Any coffee you don’t track here comes on top.',
    },
    highPotassium: {
      line: 'Above the 3,400 mg daily target by itself (spread through the day, which is good)',
      explanation: 'The NIH adequate intake for adult men is 3,400 mg/day. Potassium from food comes on top.',
    },
    adaptogenAtNight: {
      line: 'Can feel activating at night for some people',
      explanation: 'Ashwagandha and maca are usually taken earlier in the day. If sleep suffers, try them in the morning.',
    },
    missingAmount: {
      line: 'A dose has no amount',
      explanation: 'Add how much you take at each time so it shows here and counts in totals.',
    },
  };
  for (const a of advisories(stack.items, dayType, { caffeineCutoff: stack.caffeineCutoff })) {
    for (const id of a.itemIds) {
      const list = out.get(id) ?? [];
      list.push({ rule: a.rule, ...copy[a.rule] });
      out.set(id, list);
    }
  }
  return out;
}

export function buildView(stack: Stack, dayTypeId: string): SupplementsView {
  const dayType = stack.dayTypes.find((d) => d.id === dayTypeId) ?? stack.dayTypes[0] ?? NO_DAY_TYPE;
  let notesByItem = new Map<string, AdvisoryNote[]>();
  let advisoryError: unknown;
  try {
    notesByItem = notesFor(stack, dayType);
  } catch (err) {
    // Core throws RangeError for a malformed stored time; anything else is a bug and should surface.
    if (!(err instanceof RangeError)) throw err;
    advisoryError = err;
  }
  const all = placements(stack.items, dayType.id);

  const rowOf = (p: Placement): RowModel => {
    const otherSlots = all.filter((q) => q.item.id === p.item.id && q.dose.slot !== p.dose.slot);
    const protein = p.counted && hasAmount(p.dose) ? proteinGrams(p.item, p.dose.servings) : 0;
    // A daily dose limited to some day types says so, since the Every day card otherwise means every day.
    const covers = stack.dayTypes.every((d) => p.dose.dayTypes.includes(d.id));
    const only = isWorkoutSlot(p.dose.slot) || covers ? [] : dayTypeNames(p.dose, stack.dayTypes);
    const doseIndex = p.item.doses.indexOf(p.dose);
    return {
      key: `${p.item.id}:${doseIndex}`,
      item: p.item,
      slot: p.dose.slot,
      doseIndex,
      amount: p.dose.amount.trim(),
      range: p.item.doses.length === 1 ? (p.item.typicalRange.trim() || p.item.reference?.typicalRange) : undefined,
      protein: protein > 0 ? `${num(protein)} g protein` : undefined,
      detail: [only.length > 0 ? `${only.join(', ')} only` : '', ...detailLine(p.item)].filter(Boolean).join(' · '),
      note: p.item.shortNote.trim(),
      also: [...new Set(otherSlots.map((q) => SLOT_LABEL[q.dose.slot]))],
      counted: p.counted,
      advisories: (notesByItem.get(p.item.id) ?? []).filter((n) => advisoryCoversDose(n.rule, p)),
    };
  };

  const active = all.filter((p) => p.item.status === 'active');
  const group = (order: SupplementSlot[]) =>
    order.map((slot) => ({ slot, rows: active.filter((p) => p.dose.slot === slot).map(rowOf) }));
  const workout = group(WORKOUT_ORDER);
  const daily = group(DAILY_ORDER);
  const count = (g: { rows: RowModel[] }[]) => g.reduce((n, s) => n + s.rows.length, 0);

  const pending = stack.items
    .filter((i) => i.status === 'pending')
    .map((item): RowModel => {
      const dose = item.doses[0];
      const protein = dose && hasAmount(dose) ? proteinGrams(item, dose.servings) : 0;
      return {
        key: item.id,
        item,
        slot: dose?.slot,
        doseIndex: dose ? 0 : undefined,
        amount: dose?.amount.trim() ?? '',
        range: item.doses.length === 1 ? (item.typicalRange.trim() || item.reference?.typicalRange) : undefined,
        protein: protein > 0 ? `${num(protein)} g protein` : undefined,
        detail: [dose ? placementText(dose, stack.dayTypes) : '', ...detailLine(item)].filter(Boolean).join(' · '),
        note: item.shortNote.trim(),
        also: [],
        counted: false,
        advisories: [],
      };
    });

  const dayTypeIds = stack.dayTypes.length > 0 ? stack.dayTypes.map((d) => d.id) : [NO_DAY_TYPE.id];
  const unscheduled = stack.items
    .filter((i) => i.status === 'active' && !i.doses.some((d) => dayTypeIds.some((id) => doseAppliesOn(d, id))))
    .map(
      (item): RowModel => ({
        key: item.id,
        item,
        slot: item.doses[0]?.slot,
        doseIndex: item.doses[0] ? 0 : undefined,
        amount: item.doses[0]?.amount.trim() ?? '',
        detail: [item.doses.length === 0 ? 'No dose yet' : 'Not set for any day type', ...detailLine(item)].join(' · '),
        note: item.shortNote.trim(),
        also: [],
        counted: !item.unverified,
        advisories: [],
      }),
    );

  const totals = ingredientTotals(stack.items, dayType.id);
  const proteinShares = totals.find((t) => t.key === 'protein')?.shares.filter((s) => s.ng > 0) ?? [];
  const contributors = proteinShares
    .map((s) => `${stack.items.find((i) => i.id === s.itemId)?.name} (${num(fromNanograms(s.ng, 'g'))} g)`)
    .join(', ');

  return {
    dayType,
    activeCount: stack.items.filter((i) => i.status === 'active').length,
    flaggedCount: notesByItem.size,
    protein: {
      total: `${num(totalOf(totals, 'protein', 'g'))} g`,
      contributors: contributors ? `From ${contributors}` : 'None on this day',
      others: stack.dayTypes
        .filter((d) => d.id !== dayType.id)
        .map((d) => `${d.name}: ${num(totalOf(ingredientTotals(stack.items, d.id), 'protein', 'g'))} g`),
    },
    workout: {
      sessionLine: dayType.sessionTime ? `Session at ${clock12(dayType.sessionTime)}` : 'No session time set',
      count: count(workout),
      slots: workout,
    },
    daily: { count: count(daily), slots: daily },
    pending,
    unscheduled,
    notesByItem,
    advisoryError,
  };
}

// -- Detail panel ----------------------------------------------------------

export interface OverlapRow {
  key: string;
  name: string;
  thisItem: string;
  dayTotal: string;
  others: string;
}

/** Ingredients the item shares with other counted items on the day type: its share, the day total, and the others. */
export function overlapRows(stack: Stack, item: SupplementItem, dayTypeId: string): OverlapRow[] {
  const totals = ingredientTotals(stack.items, dayTypeId);
  const units = new Map<string, IngredientUnit>(itemIngredients(item).map((i) => [i.key, i.unit]));
  const rows: OverlapRow[] = [];
  for (const [key, unit] of units) {
    const shares = totals.find((t) => t.key === key)?.shares.filter((s) => s.ng > 0) ?? [];
    const mine = shares.find((s) => s.itemId === item.id);
    const others = shares.filter((s) => s.itemId !== item.id);
    if (!mine || others.length === 0) continue;
    rows.push({
      key,
      name: ingredientName(key),
      thisItem: `${num(fromNanograms(mine.ng, unit))} ${unit}`,
      dayTotal: `${num(totalOf(totals, key, unit))} ${unit}`,
      others: others
        .map((s) => `${stack.items.find((i) => i.id === s.itemId)?.name} (${num(fromNanograms(s.ng, unit))} ${unit})`)
        .join(', '),
    });
  }
  return rows;
}

// -- Where to buy ----------------------------------------------------------

/** Stores a search can be built for, by site. */
const STORE_SEARCH: Record<string, { name: string; url: (q: string) => string }> = {
  'amazon.com': { name: 'Amazon', url: (q) => `https://www.amazon.com/s?k=${q}` },
  'iherb.com': { name: 'iHerb', url: (q) => `https://www.iherb.com/search?kw=${q}` },
  'walmart.com': { name: 'Walmart', url: (q) => `https://www.walmart.com/search?q=${q}` },
  'costco.com': { name: 'Costco', url: (q) => `https://www.costco.com/CatalogSearch?keyword=${q}` },
};
const DEFAULT_STORE = 'amazon.com';

/** The https host of a link without `www.`, or undefined for anything else (so a `javascript:` link is never made a link). */
export function linkHost(link: string): string | undefined {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.replace(/^www\./, '') : undefined;
  } catch {
    return undefined;
  }
}

/** `amazon.com` as `Amazon`; a known store keeps its own spelling. */
export function storeName(host: string): string {
  if (STORE_SEARCH[host]) return STORE_SEARCH[host].name;
  const parts = host.split('.');
  const label = parts.length > 2 && ['co', 'com'].includes(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? host;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface Suggestion {
  store: string;
  url: string;
}

/**
 * A search for the item at the store the lifter links to most across the stack (Amazon when
 * they link to none we can search). None for an item that has links, and none for a mix, whose
 * parts are bought as separate products.
 */
export function suggestedSearch(stack: Stack, item: SupplementItem): Suggestion | undefined {
  if (item.links.length > 0 || item.parts) return undefined;
  return searchFor(stack, item.name);
}

/** The store search for `name`, at the store the lifter links to most across the stack. */
export function searchFor(stack: Stack, name: string): Suggestion {
  const counts = new Map<string, number>();
  for (const link of stack.items.flatMap((i) => i.links)) {
    const host = linkHost(link.url);
    const site = host && Object.keys(STORE_SEARCH).find((s) => host === s || host.endsWith(`.${s}`));
    if (site) counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  const site = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_STORE;
  return { store: STORE_SEARCH[site].name, url: STORE_SEARCH[site].url(encodeURIComponent(name)) };
}

