import { WORKOUT_SLOTS } from '@lifting-logbook/types';
import type { SupplementChange, SupplementDayType, SupplementDose, SupplementItem, SupplementStackResponse } from '@lifting-logbook/types';
import { clock12, SLOT_LABEL } from './supplementsView';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` as `Nov 18, 2026`, without going through a time zone. Anything else is shown as it is. */
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isIsoDay(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The link from a lift or PR on `date` to the stack the lifter was on that day. */
export function supplementsOnHref(date: string): string | undefined {
  return isIsoDay(date) ? `/supplements/history?date=${date}` : undefined;
}

export const REMOVED_DAY_TYPE = 'a removed day type';

/**
 * A dose in words, with its day types as they were on the date shown (`dayTypes` is that date's
 * list). An id that list doesn't have is a day type since deleted, or one the log never defined;
 * it's never shown as a bare id.
 */
export function doseText(dose: SupplementDose, dayTypes: readonly SupplementDayType[]): string {
  const names = dose.dayTypes.map((id) => dayTypes.find((d) => d.id === id)?.name ?? REMOVED_DAY_TYPE);
  const where = names.length > 0 ? `${SLOT_LABEL[dose.slot]} (${names.join(', ')})` : SLOT_LABEL[dose.slot];
  return dose.amount.trim() ? `${where} · ${dose.amount.trim()}` : where;
}

export type StackGroupKey = 'workout' | 'daily' | 'unscheduled' | 'pending';
export const STACK_GROUP_LABEL: Record<StackGroupKey, string> = {
  workout: 'Around the workout',
  daily: 'Through the day',
  unscheduled: 'Not scheduled',
  pending: 'Pending',
};

/** The as-of stack grouped as the page groups it; an item with doses in both kinds of slot is listed once, under the workout. */
export function groupStack(items: readonly SupplementItem[]): { key: StackGroupKey; items: SupplementItem[] }[] {
  const groups: Record<StackGroupKey, SupplementItem[]> = { workout: [], daily: [], unscheduled: [], pending: [] };
  for (const item of items) {
    if (item.status === 'pending') groups.pending.push(item);
    else if (item.doses.some((d) => (WORKOUT_SLOTS as readonly string[]).includes(d.slot))) groups.workout.push(item);
    else if (item.doses.length > 0) groups.daily.push(item);
    else groups.unscheduled.push(item);
  }
  return (Object.keys(groups) as StackGroupKey[]).filter((k) => groups[k].length > 0).map((key) => ({ key, items: groups[key] }));
}

/** What a change says, in words. Names are the ones the log gave the item by then, else the current stack's, else `an item`. */
export function describeChanges(log: readonly SupplementChange[], current: readonly SupplementItem[]): Map<number, string> {
  const names = new Map<string, string>(current.flatMap((i) => [[i.id, i.name], ...(i.parts ?? []).map((p): [string, string] => [p.itemId, p.name])]));
  const nameOf = (id: string) => names.get(id) ?? 'an item';
  const out = new Map<number, string>();
  for (const c of [...log].sort((a, b) => a.seq - b.seq)) {
    switch (c.type) {
      case 'added':
        names.set(c.item.id, c.item.name);
        out.set(c.seq, `Added ${c.item.name}`);
        break;
      case 'edited':
        out.set(c.seq, `Edited ${nameOf(c.itemId)}`);
        if (c.changes.name) names.set(c.itemId, c.changes.name);
        break;
      case 'moved':
        out.set(c.seq, `Changed when ${nameOf(c.itemId)} is taken`);
        break;
      case 'started':
        out.set(c.seq, `Started ${nameOf(c.itemId)}`);
        break;
      case 'moved_to_pending':
        out.set(c.seq, `Moved ${nameOf(c.itemId)} to Pending`);
        break;
      case 'removed':
        names.set(c.item.id, c.item.name);
        out.set(c.seq, `Removed ${c.item.name}`);
        break;
      case 'restored':
        out.set(c.seq, `Restored ${nameOf(c.itemId)}`);
        break;
      case 'confirmed':
        out.set(c.seq, `Confirmed ${nameOf(c.itemId)}`);
        break;
      case 'mix_created':
        names.set(c.mix.id, c.mix.name);
        out.set(c.seq, `Combined ${c.partIds.map(nameOf).join(', ')} into ${c.mix.name}`);
        break;
      case 'folded_into_mix':
        out.set(c.seq, `Folded ${nameOf(c.itemId)} into ${nameOf(c.mixId)}`);
        break;
      case 'mix_split':
        out.set(c.seq, `Split ${nameOf(c.mixId)}`);
        break;
      case 'day_types_set':
        out.set(c.seq, 'Day types changed');
        break;
      case 'caffeine_cutoff_set':
        out.set(c.seq, `Caffeine cutoff set to ${clock12(c.caffeineCutoff)}`);
        break;
    }
  }
  return out;
}

/**
 * The `removed` changes that offer Restore: an item's latest removal, when it isn't in the stack
 * now (as an item or as a part of a mix) and nothing after the removal folded it into a mix or
 * removed a mix that held it. A part folded into a mix is the mix's to split, so it isn't offered.
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
    const folded = later.some(
      (c) =>
        (c.type === 'folded_into_mix' && c.itemId === id) ||
        (c.type === 'mix_created' && c.partIds.includes(id)) ||
        (c.type === 'removed' && (c.item.parts ?? []).some((p) => p.itemId === id)),
    );
    if (!folded) out.add(seq);
  }
  return out;
}
