import type { SupplementDose, SupplementImportRowBody, SupplementLink, SupplementSheetTab, SupplementSlot } from '@lifting-logbook/types';
import { findSupplement } from '../catalog/supplements';

/**
 * Maps the rows of a supplement sheet (Nutrition_2026 › Supplements: `Compound | Amount | Timing |
 * Purpose | Notes`) to items to import (#1379). Pure, so the API and the tests share it.
 *
 * Timing is read by small named rules, each a Specification (Evans and Fowler,
 * https://martinfowler.com/apsupp/spec.pdf) that says whether it is satisfied by the text; the
 * rule matching earliest in the text wins, so `preworkout/anytime` is Pre-workout. The cell is
 * always kept as the item's timing text; a dose is added only when a rule is confident:
 *
 * - `bedtime`, `pre-bed`, `before bed`  → Night (`pm`)
 * - `preworkout`, `pre-workout`          → Pre-workout (`pre`)
 * - `postworkout`, `post-workout`        → Post-workout (`post`)
 * - `anytime`                            → Throughout the day (`all`)
 *
 * Not confident, so kept as text with no dose: a frequency (`TID`, `BID`, `QID`: one dose would
 * be wrong), a condition (`when …`, `if …`, `or`, as in `when anxious/bedtime`, `fasted or 2
 * hours post-meal`), and anything no rule names (`peri-workout`, `daily`, a blank cell).
 */
export interface TimingRule {
  name: string;
  slot: SupplementSlot;
  /** Where in the text the rule is satisfied, or -1. */
  find(text: string): number;
}

const phrase = (name: string, slot: SupplementSlot, re: RegExp): TimingRule => ({
  name,
  slot,
  find: (text) => text.search(re),
});

export const TIMING_RULES: readonly TimingRule[] = [
  phrase('night', 'pm', /\b(bed\s?time|pre-?\s?bed|before bed)\b/i),
  phrase('pre-workout', 'pre', /\bpre-?\s?workout\b/i),
  phrase('post-workout', 'post', /\bpost-?\s?workout\b/i),
  phrase('anytime', 'all', /\bany\s?time\b/i),
];

/** Texts a rule must not read: a frequency or a condition changes what one dose means. */
const NOT_CONFIDENT = /\b(tid|bid|qid)\b|\b(when|if|or)\b/i;

/** The slot the timing text names, or undefined when no rule is confident. */
export function timingSlot(text: string): SupplementSlot | undefined {
  if (NOT_CONFIDENT.test(text)) return undefined;
  const hits = TIMING_RULES.map((r) => ({ slot: r.slot, at: r.find(text) })).filter((h) => h.at >= 0);
  return hits.sort((a, b) => a.at - b.at)[0]?.slot;
}

/** A cell as text: a placeholder (`N/A`, `-`, `???`) is blank. */
export function cellText(value: string | undefined): string {
  const v = (value ?? '').trim();
  return /^(n\/?a|-+|—|\?+|none)$/i.test(v) ? '' : v;
}

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|ref|ref_|tag|linkcode|linkid|th|psc|pd_rd_.*|pf_rd_.*|content-id|keywords|qid|sr|sprefix|crid|dib.*|camp|creative.*|cv_ct_.*|mc_.*|_encoding)$/i;

/**
 * A product link without tracking: an Amazon product link becomes `https://www.amazon.<tld>/dp/<ASIN>`,
 * any other link loses its tracking parameters and fragment. Undefined when it isn't an http(s) URL.
 */
export function canonicalProductUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const amazon = /(^|\.)amazon\.([a-z.]+)$/i.exec(url.hostname);
  const asin = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname);
  if (amazon && asin) return `https://www.amazon.${amazon[2]}/dp/${(asin[1] ?? '').toUpperCase()}`;
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  url.hash = '';
  return url.toString();
}

/** A sheet row mapped to an item to import, before the lifter reviews it. */
export interface SupplementImportCandidate extends Omit<SupplementImportRowBody, 'status'> {
  /** 0-based position among the candidates. */
  index: number;
  /** The row has only a compound: it starts as pending. */
  onlyName: boolean;
  /** Index of the earlier candidate with the same name, for the lifter to merge or keep. */
  duplicateOf?: number;
}

const norm = (s: string) => s.trim().toLowerCase();

const COLUMN: Record<'name' | 'amount' | 'timing' | 'purpose' | 'notes', RegExp> = {
  name: /^(compound|supplement|name)$/i,
  amount: /^(amount|dose|dosage)$/i,
  timing: /^(timing|when)$/i,
  purpose: /^(purpose|use|uses|goal)$/i,
  notes: /^(notes?|comments?)$/i,
};

/** Rows of `tab` after its header, mapped; empty when no header names a Compound column. */
export function mapSupplementSheet(tab: Pick<SupplementSheetTab, 'rows' | 'links'>): SupplementImportCandidate[] {
  const headerAt = tab.rows.findIndex((r) => r.some((c) => COLUMN.name.test(c.trim())));
  const header = tab.rows[headerAt];
  if (!header) return [];
  const col = (k: keyof typeof COLUMN) => header.findIndex((c) => COLUMN[k].test(c.trim()));
  const at = { name: col('name'), amount: col('amount'), timing: col('timing'), purpose: col('purpose'), notes: col('notes') };
  const get = (row: string[], i: number) => (i < 0 ? '' : cellText(row[i]));

  const out: SupplementImportCandidate[] = [];
  const firstByName = new Map<string, number>();
  for (let r = headerAt + 1; r < tab.rows.length; r++) {
    const row = tab.rows[r] ?? [];
    const name = get(row, at.name);
    if (name === '') continue;
    const amount = get(row, at.amount);
    const timing = get(row, at.timing);
    const purpose = get(row, at.purpose);
    const entry = findSupplement(name) ?? findSupplement(name.replace(/\s*\(.*\)\s*/g, ' '));
    const slot = timingSlot(timing);
    const doses: SupplementDose[] = slot ? [{ slot, amount, servings: 1, dayTypes: [] }] : [];
    const href = at.name < 0 ? '' : (tab.links[r]?.[at.name] ?? '');
    const url = href === '' ? undefined : canonicalProductUrl(href);
    const links: SupplementLink[] = url ? [{ label: '', url }] : [];
    const index = out.length;
    const dup = firstByName.get(norm(name));
    if (dup === undefined) firstByName.set(norm(name), index);
    out.push({
      index,
      name,
      ...(entry ? { catalogKey: entry.key } : {}),
      timing,
      // Purpose fills the short note only when the catalog has no uses for the item.
      shortNote: entry && entry.uses.length > 0 ? '' : purpose,
      longNote: get(row, at.notes),
      links,
      doses,
      onlyName: amount === '' && timing === '' && purpose === '' && get(row, at.notes) === '',
      ...(dup === undefined ? {} : { duplicateOf: dup }),
    });
  }
  return out;
}

/** What the lifter decides for a row; `merge` folds a duplicate into the row it repeats. */
export type ImportDecision = 'active' | 'pending' | 'skip' | 'merge';

const join = (a: string, b: string) => (a === '' ? b : b === '' || b === a ? a : `${a}; ${b}`);

/** The rows to import: skipped rows left out, merged rows folded into the row they repeat. */
export function applyImportReview(
  candidates: readonly SupplementImportCandidate[],
  decisions: readonly ImportDecision[],
): SupplementImportRowBody[] {
  const rows = new Map<number, SupplementImportRowBody>();
  candidates.forEach((c, i) => {
    const d = decisions[i] ?? 'skip';
    const { index: _i, onlyName: _o, duplicateOf, ...body } = c;
    if (d === 'skip') return;
    if (d === 'merge' && duplicateOf !== undefined) {
      const into = rows.get(duplicateOf);
      if (into) {
        into.timing = join(into.timing, body.timing);
        into.longNote = join(into.longNote, body.longNote);
        into.shortNote = into.shortNote || body.shortNote;
        into.links.push(...body.links.filter((l) => !into.links.some((x) => x.url === l.url)));
        into.doses.push(...body.doses.filter((x) => !into.doses.some((y) => y.slot === x.slot)));
        return;
      }
    }
    rows.set(i, { ...body, links: [...body.links], doses: body.doses.map((x) => ({ ...x })), status: d === 'pending' ? 'pending' : 'active' });
  });
  return [...rows.values()];
}

/** A review's starting decisions: a row with only a compound is pending, a repeat is kept. */
export const defaultDecisions = (candidates: readonly SupplementImportCandidate[]): ImportDecision[] =>
  candidates.map((c) => (c.onlyName ? 'pending' : 'active'));
