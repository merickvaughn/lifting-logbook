import type { SupplementChange, SupplementItem } from '@lifting-logbook/types';

/**
 * Replays the append-only change log to the stack at the end of `date` (`YYYY-MM-DD`).
 * Removed items and items folded into a mix are absent; a mix carries its parts.
 */
export function stackAsOf(changeLog: readonly SupplementChange[], date: string): SupplementItem[] {
  const items = new Map<string, SupplementItem>();
  const hidden = new Set<string>(); // removed or folded into a mix
  const folded = new Set<string>();

  const ordered = changeLog
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.date <= date)
    .sort((a, b) => (a.c.date < b.c.date ? -1 : a.c.date > b.c.date ? 1 : a.i - b.i));

  for (const { c } of ordered) {
    switch (c.type) {
      case 'added':
        items.set(c.item.id, c.item);
        hidden.delete(c.item.id);
        break;
      case 'edited':
        patch(items, c.itemId, c.changes);
        break;
      case 'moved':
        patch(items, c.itemId, { doses: c.doses });
        break;
      case 'started':
        patch(items, c.itemId, { status: 'active' });
        break;
      case 'moved_to_pending':
        patch(items, c.itemId, { status: 'pending' });
        break;
      case 'confirmed':
        patch(items, c.itemId, { unverified: false });
        break;
      case 'removed':
        hidden.add(c.itemId);
        break;
      case 'restored':
        if (!folded.has(c.itemId)) hidden.delete(c.itemId);
        break;
      case 'mix_created': {
        const parts = c.partIds.flatMap((id) => {
          const p = items.get(id);
          return p ? [{ name: p.name, ingredients: p.ingredients }] : [];
        });
        items.set(c.mix.id, { ...c.mix, parts: c.mix.parts ?? parts });
        for (const id of c.partIds) fold(hidden, folded, id);
        break;
      }
      case 'folded_into_mix': {
        const mix = items.get(c.mixId);
        const part = items.get(c.itemId);
        if (mix && part) {
          items.set(mix.id, {
            ...mix,
            parts: [...(mix.parts ?? []), { name: part.name, ingredients: part.ingredients }],
          });
          fold(hidden, folded, c.itemId);
        }
        break;
      }
    }
  }
  return [...items.values()].filter((i) => !hidden.has(i.id));
}

function patch(items: Map<string, SupplementItem>, id: string, changes: Partial<SupplementItem>) {
  const item = items.get(id);
  if (item) items.set(id, { ...item, ...changes });
}

function fold(hidden: Set<string>, folded: Set<string>, id: string) {
  hidden.add(id);
  folded.add(id);
}
