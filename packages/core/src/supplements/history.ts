import type { SupplementChange, SupplementItem, SupplementPart } from '@lifting-logbook/types';
import { parseIsoDate } from '../focus/dates';

/**
 * Why replay skipped a change, or part of one: it named an item the log hasn't added
 * (`unknown-item`), an item already folded into a mix (`folded-item`), or split an item
 * that isn't a mix (`not-a-mix`).
 */
export type ReplayAnomalyReason = 'unknown-item' | 'folded-item' | 'not-a-mix';

export interface ReplayAnomaly {
  change: SupplementChange;
  /** The id the change named that replay couldn't act on. */
  itemId: string;
  reason: ReplayAnomalyReason;
}

export interface StackReplay {
  stack: SupplementItem[];
  /** Changes, or parts of changes, that had no effect. Empty for a complete, well-ordered log. */
  anomalies: ReplayAnomaly[];
}

const partOf = (item: SupplementItem): SupplementPart => ({
  itemId: item.id,
  name: item.name,
  ingredients: item.ingredients,
});

/**
 * Replays the append-only change log to the stack at the end of `date` (`YYYY-MM-DD`), in
 * `(date, seq)` order. Removed items and items folded into a mix are absent; a mix carries
 * its parts. Throws a RangeError when `date` or a change's date isn't an ISO date.
 */
export function stackAsOf(changeLog: readonly SupplementChange[], date: string): StackReplay {
  parseIsoDate(date);
  for (const c of changeLog) parseIsoDate(c.date);

  const items = new Map<string, SupplementItem>();
  const hidden = new Set<string>(); // removed or folded into a mix
  const folded = new Set<string>();
  const anomalies: ReplayAnomaly[] = [];
  const skip = (change: SupplementChange, itemId: string, reason: ReplayAnomalyReason) =>
    anomalies.push({ change, itemId, reason });

  /** The item if replay can act on it; otherwise records why not and returns undefined. */
  const live = (change: SupplementChange, id: string): SupplementItem | undefined => {
    const item = items.get(id);
    if (!item) skip(change, id, 'unknown-item');
    else if (folded.has(id)) skip(change, id, 'folded-item');
    else return item;
    return undefined;
  };
  const patch = (change: SupplementChange, id: string, changes: Partial<SupplementItem>) => {
    const item = live(change, id);
    if (item) items.set(id, { ...item, ...changes });
  };

  const ordered = changeLog
    .filter((c) => c.date <= date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));

  for (const c of ordered) {
    switch (c.type) {
      case 'added':
        if (folded.has(c.item.id)) {
          skip(c, c.item.id, 'folded-item');
          break;
        }
        items.set(c.item.id, c.item);
        hidden.delete(c.item.id);
        break;
      case 'edited':
        patch(c, c.itemId, c.changes);
        break;
      case 'moved':
        patch(c, c.itemId, { doses: c.doses });
        break;
      case 'started':
        patch(c, c.itemId, { status: 'active' });
        break;
      case 'moved_to_pending':
        patch(c, c.itemId, { status: 'pending' });
        break;
      case 'confirmed':
        patch(c, c.itemId, { unverified: false });
        break;
      case 'removed':
        if (live(c, c.item.id)) hidden.add(c.item.id);
        break;
      case 'restored':
        if (live(c, c.itemId)) hidden.delete(c.itemId);
        break;
      case 'mix_created': {
        const parts = c.partIds.flatMap((id) => {
          const p = live(c, id);
          return p ? [partOf(p)] : [];
        });
        for (const part of parts) fold(hidden, folded, part.itemId);
        const mixParts = c.mix.parts ?? parts;
        // With no parts, the mix keeps its own ingredients rather than totalling nothing.
        items.set(c.mix.id, mixParts.length > 0 ? { ...c.mix, parts: mixParts } : c.mix);
        hidden.delete(c.mix.id);
        break;
      }
      case 'folded_into_mix': {
        const mix = live(c, c.mixId);
        const part = live(c, c.itemId);
        if (mix && part) {
          // Folding into a plain item turns it into a mix; its own ingredients become a part.
          const parts = mix.parts ?? [partOf(mix)];
          items.set(mix.id, { ...mix, parts: [...parts, partOf(part)] });
          fold(hidden, folded, part.id);
        }
        break;
      }
      case 'mix_split': {
        const mix = live(c, c.mixId);
        if (!mix) break;
        if (!mix.parts) {
          skip(c, c.mixId, 'not-a-mix');
          break;
        }
        let ownPart = false;
        for (const part of mix.parts) {
          if (part.itemId === mix.id) {
            ownPart = true;
          } else if (!items.has(part.itemId)) {
            skip(c, part.itemId, 'unknown-item');
          } else if (folded.delete(part.itemId)) {
            hidden.delete(part.itemId);
          }
        }
        if (ownPart) {
          // An item that became a mix by having others folded in goes back to being itself.
          const { parts: _parts, ...plain } = mix;
          items.set(mix.id, plain);
        } else {
          // Gone for good: restoring it would count its parts twice.
          items.delete(mix.id);
        }
        break;
      }
    }
  }
  return { stack: [...items.values()].filter((i) => !hidden.has(i.id)), anomalies };
}

function fold(hidden: Set<string>, folded: Set<string>, id: string) {
  hidden.add(id);
  folded.add(id);
}
