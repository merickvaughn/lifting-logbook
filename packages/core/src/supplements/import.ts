import type { SupplementDose, SupplementImportRowBody, SupplementLink, SupplementSheetTab, SupplementSlot } from '@lifting-logbook/types';
import { SUPPLEMENT_TEXT_MAX } from '@lifting-logbook/types';
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
 * hours post-meal`), and anything no rule names (`peri-workout`, `daily`, a blank cell). With no
 * dose to hold it, the Amount goes in front of the timing text (`applyImportReview`).
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

const NAME_MAX = SUPPLEMENT_TEXT_MAX.name;
const TEXT_MAX = SUPPLEMENT_TEXT_MAX.text;

/** `s` cut to `max` characters, the import endpoint's limit, so one long cell can't fail the import. */
const clamp = (s: string, max: number) => (s.length > max ? [...s].slice(0, max).join('') : s);

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|ref|ref_|tag|linkcode|linkid|th|psc|pd_rd_.*|pf_rd_.*|content-id|keywords|qid|sr|sprefix|crid|dib.*|camp|creative.*|cv_ct_.*|mc_.*|_encoding)$/i;

/** Amazon's retail sites. A link is read as an Amazon product only on one of these, with or without `www.`. */
const AMAZON_DOMAINS = new Set(
  ['com', 'ca', 'com.mx', 'com.br', 'co.uk', 'de', 'fr', 'it', 'es', 'nl', 'se', 'pl', 'com.be', 'com.tr', 'ae', 'sa', 'eg', 'in', 'co.jp', 'sg', 'com.au'].map(
    (tld) => `amazon.${tld}`,
  ),
);

/**
 * A host `LinkDto`'s `@IsUrl` accepts: dotted, ending in a letter TLD (or punycode). So not
 * `localhost`, a bare name, or an IP address.
 */
const SAVABLE_HOST = /^([a-z0-9-]+\.)+([a-z]{2,}|xn--[a-z0-9-]+)$/;

/**
 * A product link without tracking: an Amazon product link becomes `https://www.amazon.<tld>/dp/<ASIN>`,
 * any other link loses its tracking parameters, fragment and any user name or password. Undefined
 * when the item form couldn't save it: not an http(s) URL, a host `@IsUrl` rejects, or too long.
 */
export function canonicalProductUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (!SAVABLE_HOST.test(url.hostname)) return undefined;
  url.username = '';
  url.password = '';
  const domain = url.hostname.replace(/^www\./, '');
  const asin = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname);
  if (AMAZON_DOMAINS.has(domain) && asin) return `https://www.${domain}/dp/${(asin[1] ?? '').toUpperCase()}`;
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  url.hash = '';
  const out = url.toString();
  return out.length > TEXT_MAX ? undefined : out;
}

/** A sheet row mapped to an item to import, before the lifter reviews it. */
export interface SupplementImportCandidate extends Omit<SupplementImportRowBody, 'status'> {
  /** 0-based position among the candidates. */
  index: number;
  /** The row's number in the sheet, 1-based as the sheet shows it. */
  sheetRow: number;
  /** The row has only a compound: it starts as pending. */
  onlyName: boolean;
  /** An item in the stack has the same name or catalog entry: it starts as skipped. */
  inStack: boolean;
  /** Index of the earlier candidate with the same name or catalog entry, for the lifter to merge or keep. */
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

/**
 * Rows of `tab` after its header, mapped; empty when no header names a Compound column. `stack` is
 * the items already in the stack, so a row repeating one starts as skipped.
 */
export function mapSupplementSheet(
  tab: Pick<SupplementSheetTab, 'rows' | 'links' | 'rowNumbers'>,
  stack: readonly { name: string; catalogKey?: string }[] = [],
): SupplementImportCandidate[] {
  const headerAt = tab.rows.findIndex((r) => r.some((c) => COLUMN.name.test(c.trim())));
  const header = tab.rows[headerAt];
  if (!header) return [];
  const col = (k: keyof typeof COLUMN) => header.findIndex((c) => COLUMN[k].test(c.trim()));
  const at = { name: col('name'), amount: col('amount'), timing: col('timing'), purpose: col('purpose'), notes: col('notes') };
  const get = (row: string[], i: number) => (i < 0 ? '' : cellText(row[i]));
  const stackNames = new Set(stack.map((i) => norm(i.name)));
  const stackKeys = new Set(stack.flatMap((i) => (i.catalogKey === undefined ? [] : [i.catalogKey])));

  const out: SupplementImportCandidate[] = [];
  const firstByName = new Map<string, number>();
  const firstByKey = new Map<string, number>();
  for (let r = headerAt + 1; r < tab.rows.length; r++) {
    const row = tab.rows[r] ?? [];
    const cell = get(row, at.name);
    if (cell === '') continue;
    const name = clamp(cell, NAME_MAX);
    const amount = clamp(get(row, at.amount), NAME_MAX);
    const timingCell = get(row, at.timing);
    const timing = clamp(timingCell, NAME_MAX);
    const purpose = get(row, at.purpose);
    const notes = get(row, at.notes);
    const entry = findSupplement(cell) ?? findSupplement(cell.replace(/\s*\(.*\)\s*/g, ' '));
    const slot = timingSlot(timingCell);
    const doses: SupplementDose[] = slot ? [{ slot, amount, servings: 1, dayTypes: [] }] : [];
    const href = at.name < 0 ? '' : (tab.links[r]?.[at.name] ?? '');
    const url = href === '' ? undefined : canonicalProductUrl(href);
    const links: SupplementLink[] = url ? [{ label: '', url }] : [];
    const index = out.length;
    const first = firstByName.get(norm(name)) ?? (entry ? firstByKey.get(entry.key) : undefined);
    // The row the earliest repeat is of, so a merge never targets a row that is itself merged away.
    const dup = first === undefined ? undefined : (out[first]?.duplicateOf ?? first);
    if (!firstByName.has(norm(name))) firstByName.set(norm(name), index);
    if (entry && !firstByKey.has(entry.key)) firstByKey.set(entry.key, index);
    out.push({
      index,
      sheetRow: tab.rowNumbers?.[r] ?? r + 1,
      name,
      ...(entry ? { catalogKey: entry.key } : {}),
      amount,
      timing,
      // Purpose fills the short note only when the catalog has no uses for the item.
      shortNote: entry && entry.uses.length > 0 ? '' : clamp(purpose, TEXT_MAX),
      longNote: clamp(notes, TEXT_MAX),
      links,
      doses,
      onlyName: amount === '' && timing === '' && purpose === '' && notes === '',
      inStack: stackNames.has(norm(name)) || (entry !== undefined && stackKeys.has(entry.key)),
      ...(dup === undefined ? {} : { duplicateOf: dup }),
    });
  }
  return out;
}

/** What the lifter decides for a row; `merge` folds a duplicate into the row it repeats. */
export type ImportDecision = 'active' | 'pending' | 'skip' | 'merge';

const join = (a: string, b: string) => (a === '' ? b : b === '' || b === a ? a : `${a}; ${b}`);

/** The row with its amount in front of its timing text when no dose holds the amount. */
const keepAmount = (body: Omit<SupplementImportRowBody, 'status'>) =>
  body.amount === '' || body.doses.some((d) => d.amount === body.amount)
    ? body
    : { ...body, timing: clamp(`${body.amount} ${body.timing}`.trim(), NAME_MAX) };

/**
 * The rows to import: skipped rows left out, merged rows folded into the row they repeat.
 *
 * A row with no dose holding its amount (no timing rule was confident) has the amount put in front
 * of its timing text, `1000mg TID w/ food`, so the amount isn't lost. A merged row's timing and
 * notes join the target's; its dose in a slot the target already has adds its amount to that
 * dose's (`3g + 2g`), and a dose in any other slot is added. Texts are cut to the endpoint's limits.
 *
 * A row set to merge into a row that is skipped, or that isn't a duplicate, is imported as its own
 * active row rather than dropped: the lifter didn't ask to lose it. The dialog doesn't offer that
 * choice, so this only covers a decision gone stale.
 */
export function applyImportReview(
  candidates: readonly SupplementImportCandidate[],
  decisions: readonly ImportDecision[],
): SupplementImportRowBody[] {
  const rows = new Map<number, SupplementImportRowBody>();
  candidates.forEach((c, i) => {
    const d = decisions[i] ?? 'skip';
    const { index: _i, sheetRow: _r, onlyName: _o, inStack: _s, duplicateOf, ...fields } = c;
    if (d === 'skip') return;
    const body = keepAmount(fields);
    if (d === 'merge' && duplicateOf !== undefined) {
      const into = rows.get(duplicateOf);
      if (into) {
        into.timing = clamp(join(into.timing, body.timing), NAME_MAX);
        into.longNote = clamp(join(into.longNote, body.longNote), TEXT_MAX);
        into.shortNote = into.shortNote || body.shortNote;
        into.links.push(...body.links.filter((l) => !into.links.some((x) => x.url === l.url)));
        for (const dose of body.doses) {
          const same = into.doses.find((x) => x.slot === dose.slot);
          if (same) same.amount = clamp([same.amount, dose.amount].filter((a) => a !== '').join(' + '), NAME_MAX);
          else into.doses.push({ ...dose });
        }
        return;
      }
    }
    rows.set(i, { ...body, links: [...body.links], doses: body.doses.map((x) => ({ ...x })), status: d === 'pending' ? 'pending' : 'active' });
  });
  return [...rows.values()];
}

/** A review's starting decisions: a row already in the stack is skipped, one with only a compound is pending, a repeat is kept. */
export const defaultDecisions = (candidates: readonly SupplementImportCandidate[]): ImportDecision[] =>
  candidates.map((c) => (c.inStack ? 'skip' : c.onlyName ? 'pending' : 'active'));
