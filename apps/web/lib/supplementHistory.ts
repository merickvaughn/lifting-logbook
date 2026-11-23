import type { SupplementChange, SupplementDayType, SupplementItem, SupplementStackResponse } from '@lifting-logbook/types';
import { clock12, placementText } from './supplementsView';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` as `Nov 18, 2026`, without going through a time zone. Anything else is shown as it is. */
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

/** `Nov 18` for a day in the same year as `today`, else `Nov 18, 2025`. */
export function shortDay(iso: string, today: string): string {
  const full = formatDay(iso);
  return iso.slice(0, 4) === today.slice(0, 4) ? full.replace(/, \d{4}$/, '') : full;
}

/**
 * True for a real calendar day written `YYYY-MM-DD`, from the year 1000 on. A date field holds
 * `0002-01-01` part-way through typing a year, and that isn't a day anyone means.
 */
export function isIsoDay(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s < '1000') return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The link from a lift or PR on `date` to the History dialog, open at the stack of that day. */
export function supplementsOnHref(date: string): string | undefined {
  return isIsoDay(date) ? `/supplements?history=${date}` : undefined;
}

export const REMOVED_DAY_TYPE = 'a removed day type';

/**
 * An item's doses in words, joined with ` + `: `1 scoop · Pre-workout (Lift day)`, with `dose?`
 * for a dose with no amount. Day types are named as they were on the date shown (`dayTypes` is
 * that date's list); an id the list lacks is a day type since deleted, never shown as a bare id.
 */
export function dosesText(item: SupplementItem, dayTypes: readonly SupplementDayType[]): string {
  if (item.doses.length === 0) return 'not scheduled';
  return item.doses.map((d) => `${d.amount.trim() || 'dose?'} · ${placementText(d, dayTypes, REMOVED_DAY_TYPE)}`).join(' + ');
}

/** A change in words: the verb, shown bold, and what it acted on. */
export interface ChangeWords {
  verb: string;
  object: string;
}

/**
 * What each change says, keyed by `seq`. An item is named as the log had named it by then; for an
 * item whose add is on a page not loaded, the name a removal or a mix in the loaded log recorded,
 * else the current stack's, else `an item`.
 */
export function describeChanges(log: readonly SupplementChange[], current: readonly SupplementItem[]): Map<number, ChangeWords> {
  const names = new Map<string, string>();
  const learn = (i: SupplementItem) => {
    names.set(i.id, i.name);
    for (const p of i.parts ?? []) names.set(p.itemId, p.name);
  };
  current.forEach(learn);
  const sorted = [...log].sort((a, b) => a.seq - b.seq);
  for (const c of sorted) {
    if (c.type === 'removed') learn(c.item);
    if (c.type === 'mix_created') learn(c.mix);
  }
  const nameOf = (id: string) => names.get(id) ?? 'an item';
  const out = new Map<number, ChangeWords>();
  const say = (c: SupplementChange, verb: string, object: string) => out.set(c.seq, { verb, object });
  for (const c of sorted) {
    switch (c.type) {
      case 'added':
        names.set(c.item.id, c.item.name);
        say(c, 'Added', c.item.name);
        break;
      case 'edited':
        say(c, 'Edited', nameOf(c.itemId));
        if (c.changes.name) names.set(c.itemId, c.changes.name);
        break;
      case 'moved':
        say(c, 'Changed', `when ${nameOf(c.itemId)} is taken`);
        break;
      case 'started':
        say(c, 'Started', nameOf(c.itemId));
        break;
      case 'moved_to_pending':
        say(c, 'Moved', `${nameOf(c.itemId)} to Pending`);
        break;
      case 'removed':
        names.set(c.item.id, c.item.name);
        say(c, 'Removed', c.item.name);
        break;
      case 'restored':
        say(c, 'Restored', nameOf(c.itemId));
        break;
      case 'confirmed':
        say(c, 'Confirmed', nameOf(c.itemId));
        break;
      case 'mix_created':
        names.set(c.mix.id, c.mix.name);
        say(c, 'Combined', `${c.partIds.map(nameOf).join(', ')} into ${c.mix.name}`);
        break;
      case 'folded_into_mix':
        say(c, 'Folded', `${nameOf(c.itemId)} into ${nameOf(c.mixId)}`);
        break;
      case 'mix_split':
        say(c, 'Split', nameOf(c.mixId));
        break;
      case 'day_types_set':
        say(c, 'Changed', 'the day types');
        break;
      case 'caffeine_cutoff_set':
        say(c, 'Set', `the caffeine cutoff to ${clock12(c.caffeineCutoff)}`);
        break;
      default: {
        const unknown: never = c;
        return unknown;
      }
    }
  }
  return out;
}

/**
 * The `removed` changes that offer Restore: an item's latest removal, when it isn't in the stack
 * now (as an item or as a part of a mix) and nothing after the removal undid it or took the item
 * into a mix. A later `restored` undid it, even if the item has gone since without a removal, as
 * a mix split back into its parts. A part folded into a mix, or held by a mix removed since, is
 * the mix's to restore or split, so it isn't offered.
 */
export function restorableSeqs(log: readonly SupplementChange[], current: SupplementStackResponse): Set<number> {
  const inStack = new Set(current.items.flatMap((i) => [i.id, ...(i.parts ?? []).map((p) => p.itemId)]));
  const sorted = [...log].sort((a, b) => a.seq - b.seq);
  const latest = new Map<string, number>();
  for (const c of sorted) if (c.type === 'removed') latest.set(c.item.id, c.seq);
  const out = new Set<number>();
  for (const [id, seq] of latest) {
    if (inStack.has(id)) continue;
    const later = sorted.filter((c) => c.seq > seq);
    const gone = later.some(
      (c) =>
        (c.type === 'restored' && c.itemId === id) ||
        (c.type === 'folded_into_mix' && c.itemId === id) ||
        (c.type === 'mix_created' && c.partIds.includes(id)) ||
        (c.type === 'removed' && (c.item.parts ?? []).some((p) => p.itemId === id)),
    );
    if (!gone) out.add(seq);
  }
  return out;
}
