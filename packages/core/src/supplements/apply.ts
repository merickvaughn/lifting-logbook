import type {
  SupplementChange,
  SupplementDayType,
  SupplementItem,
  SupplementPart,
  SupplementReplayAnomalyReason,
} from '@lifting-logbook/types';

type WithoutDateSeq<C> = C extends unknown ? Omit<C, 'date' | 'seq'> : never;
/** A change without its date and `seq`: what applying it needs. */
export type SupplementChangeBody = WithoutDateSeq<SupplementChange>;

/** An item folded into a mix, kept so splitting the mix brings it back. */
export interface FoldedSupplementItem {
  item: SupplementItem;
  mixId: string;
}

/**
 * The supplement stack and everything a change can act on (#1374). The API's stored state and
 * the change log's replay are both this shape, and both change only through `applyChange`, so
 * the stack a write saves is the stack replay reaches (ADR-046).
 */
export interface SupplementStackState {
  /** The stack, in order. */
  items: SupplementItem[];
  /** Items folded into a mix, in the order they were folded. */
  folded: FoldedSupplementItem[];
  /** Removed items as each was removed, latest last; restoring one brings it back. */
  removed: SupplementItem[];
  dayTypes: SupplementDayType[];
  /** Null until a change sets one. */
  caffeineCutoff: string | null;
}

/** A change, or part of one, that `applyChange` couldn't act on. */
export interface ApplyAnomaly {
  /** The id the change named. */
  itemId: string;
  reason: SupplementReplayAnomalyReason;
}

export const emptyStackState = (): SupplementStackState => ({
  items: [],
  folded: [],
  removed: [],
  dayTypes: [],
  caffeineCutoff: null,
});

const partOf = (item: SupplementItem): SupplementPart => ({
  itemId: item.id,
  name: item.name,
  ingredients: item.ingredients,
});

/**
 * Applies one change to `state`, in place, and returns what it couldn't act on. A change that
 * names an item not in the stack changes nothing for that item, except a `moved` change, which
 * also reaches an item folded into a mix: taking a day type off every dose includes those
 * (ADR-046).
 *
 * A mix takes the place of its first part, and a split puts the parts back where the mix was.
 * A restored item goes to the end of the stack.
 */
export function applyChange(state: SupplementStackState, change: SupplementChangeBody): ApplyAnomaly[] {
  const anomalies: ApplyAnomaly[] = [];

  /** The item and its index in the stack, or undefined after recording why it isn't there. */
  const live = (id: string): { index: number; item: SupplementItem } | undefined => {
    const index = state.items.findIndex((i) => i.id === id);
    const item = state.items[index];
    if (item) return { index, item };
    anomalies.push({ itemId: id, reason: absence(state, id) });
    return undefined;
  };
  const patch = (id: string, changes: Partial<SupplementItem>) => {
    const found = live(id);
    if (found) state.items[found.index] = { ...found.item, ...changes };
  };

  switch (change.type) {
    case 'added': {
      const { item } = change;
      if (state.folded.some((f) => f.item.id === item.id)) {
        anomalies.push({ itemId: item.id, reason: 'folded-item' });
        break;
      }
      state.removed = state.removed.filter((r) => r.id !== item.id);
      const index = state.items.findIndex((i) => i.id === item.id);
      if (index < 0) state.items.push(item);
      else state.items[index] = item;
      break;
    }
    case 'edited':
      patch(change.itemId, change.changes);
      break;
    case 'moved': {
      const folded = state.folded.findIndex((f) => f.item.id === change.itemId);
      const entry = state.folded[folded];
      if (entry) state.folded[folded] = { ...entry, item: { ...entry.item, doses: change.doses } };
      else patch(change.itemId, { doses: change.doses });
      break;
    }
    case 'started':
      patch(change.itemId, { status: 'active' });
      break;
    case 'moved_to_pending':
      patch(change.itemId, { status: 'pending' });
      break;
    case 'confirmed':
      patch(change.itemId, { unverified: false });
      break;
    case 'removed': {
      const found = live(change.item.id);
      if (!found) break;
      state.items.splice(found.index, 1);
      state.removed.push(change.item);
      break;
    }
    case 'restored': {
      const reason = absence(state, change.itemId);
      const index = state.removed.map((r) => r.id).lastIndexOf(change.itemId);
      const item = state.removed[index];
      if (!item || reason !== 'removed-item') {
        anomalies.push({ itemId: change.itemId, reason });
        break;
      }
      state.removed.splice(index, 1);
      state.items.push(item);
      break;
    }
    case 'mix_created': {
      const parts = change.partIds.flatMap((id) => {
        const found = live(id);
        return found ? [found] : [];
      });
      const mixParts = change.mix.parts ?? parts.map(({ item }) => partOf(item));
      // With no parts, the mix keeps its own ingredients rather than totalling nothing.
      const mix = mixParts.length > 0 ? { ...change.mix, parts: mixParts } : change.mix;
      const first = parts[0];
      if (first) state.items[first.index] = mix;
      else state.items.push(mix);
      const partItems = new Set(parts.map(({ item }) => item));
      state.items = state.items.filter((i) => !partItems.has(i));
      state.folded.push(...parts.map(({ item }) => ({ item, mixId: mix.id })));
      break;
    }
    case 'folded_into_mix': {
      const mix = live(change.mixId);
      const part = live(change.itemId);
      if (!mix || !part) break;
      // Folding into a plain item turns it into a mix; its own ingredients become a part.
      const parts = mix.item.parts ?? [partOf(mix.item)];
      state.items[mix.index] = { ...mix.item, parts: [...parts, partOf(part.item)] };
      state.items.splice(part.index, 1);
      state.folded.push({ item: part.item, mixId: mix.item.id });
      break;
    }
    case 'mix_split': {
      const found = live(change.mixId);
      if (!found) break;
      const { parts, ...own } = found.item;
      if (!parts) {
        anomalies.push({ itemId: change.mixId, reason: 'not-a-mix' });
        break;
      }
      // An item that became a mix by having others folded in goes back to being itself; a mix
      // made from parts goes for good, since restoring it would count its parts twice.
      const back: SupplementItem[] = parts.some((p) => p.itemId === own.id) ? [own] : [];
      for (const part of parts) {
        if (part.itemId === own.id) continue;
        const index = state.folded.findIndex((f) => f.mixId === own.id && f.item.id === part.itemId);
        const entry = state.folded[index];
        if (!entry) {
          anomalies.push({ itemId: part.itemId, reason: 'unknown-item' });
          continue;
        }
        state.folded.splice(index, 1);
        back.push(entry.item);
      }
      state.items.splice(found.index, 1, ...back);
      break;
    }
    case 'day_types_set':
      state.dayTypes = change.dayTypes;
      break;
    case 'caffeine_cutoff_set':
      state.caffeineCutoff = change.caffeineCutoff;
      break;
  }
  return anomalies;
}

/** Why `id` isn't in the stack. */
function absence(state: SupplementStackState, id: string): SupplementReplayAnomalyReason {
  if (state.items.some((i) => i.id === id)) return 'not-removed';
  if (state.folded.some((f) => f.item.id === id)) return 'folded-item';
  if (state.removed.some((r) => r.id === id)) return 'removed-item';
  return 'unknown-item';
}
