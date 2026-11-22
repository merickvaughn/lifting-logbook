import { isSameData } from '@lifting-logbook/core';
import { SupplementChange, SupplementItem } from '@lifting-logbook/types';
import {
  ISupplementRepository,
  SupplementChangePage,
  SupplementState,
  SupplementWritePlan,
} from '../../ports/ISupplementRepository';
import { StoredRow } from '../../ports/IUserDataExportRepository';

/**
 * Mirrors PrismaSupplementRepository: writes run one at a time, as the per-user lock makes them
 * there, each saves all or nothing, and a write that changes the state must log a change.
 */
export class InMemorySupplementRepository implements ISupplementRepository {
  private state: SupplementState = {
    items: [],
    folded: [],
    removed: [],
    dayTypes: [],
    caffeineCutoff: null,
    nextSeq: 1,
    lastChangeDate: null,
  };
  private readonly log: SupplementChange[] = [];
  /** The write lock: each write starts after the one before it settles. */
  private queue: Promise<unknown> = Promise.resolve();

  async load(): Promise<SupplementState> {
    return structuredClone(this.state);
  }

  async changes(page: SupplementChangePage): Promise<SupplementChange[]> {
    const before = this.log.filter((c) => page.beforeSeq === undefined || c.seq < page.beforeSeq);
    return structuredClone(before.slice(Math.max(0, before.length - page.limit)));
  }

  async changesThrough(date: string): Promise<SupplementChange[]> {
    return structuredClone(this.log.filter((c) => c.date <= date));
  }

  async firstChangeDate(): Promise<string | null> {
    return this.log.reduce<string | null>((min, c) => (min === null || c.date < min ? c.date : min), null);
  }

  async lastRemoved(itemId: string): Promise<SupplementItem | undefined> {
    const removed = this.log.filter((c) => c.type === 'removed' && c.item.id === itemId).pop();
    if (removed?.type !== 'removed') return undefined;
    const undone = this.log.some((c) => c.seq > removed.seq && c.type === 'restored' && c.itemId === itemId);
    return undone ? undefined : structuredClone(removed.item);
  }

  async write(plan: SupplementWritePlan): Promise<SupplementState> {
    const run = this.queue.then(async () => {
      const state = structuredClone(this.state);
      const changes = await plan(state);
      const changed = !isSameData(
        [state.items, state.folded, state.dayTypes, state.caffeineCutoff],
        [this.state.items, this.state.folded, this.state.dayTypes, this.state.caffeineCutoff],
      );
      if (changed && changes.length === 0) throw new Error('A supplement write changed the stack without logging a change');
      const numbered = changes.map((c, i) => ({ ...c, seq: state.nextSeq + i }));
      this.state = structuredClone({
        ...state,
        removed: [],
        nextSeq: state.nextSeq + changes.length,
        lastChangeDate: changes[0]?.date ?? state.lastChangeDate,
      });
      this.log.push(...structuredClone(numbered));
      return structuredClone(this.state);
    });
    // The next write waits for this one, whether it succeeds or not; the caller still gets the
    // error through `run`. A write after a refused one succeeding is asserted by "requires today
    // on every write, and refuses one dated before the last change".
    // fallback-covered-by: apps/api/src/supplements/supplements.e2e.spec.ts
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The stored rows, shaped like the Prisma tables', for Download My Data. */
  exportRows(): {
    supplementDayTypes: StoredRow[];
    supplementItems: StoredRow[];
    supplementDoses: StoredRow[];
    supplementMixParts: StoredRow[];
    supplementChanges: StoredRow[];
  } {
    const stored = [
      ...this.state.items.map((item) => ({ item, foldedInto: null })),
      ...this.state.folded.map(({ item, mixId }) => ({ item, foldedInto: mixId })),
    ];
    return structuredClone({
      supplementDayTypes: this.state.dayTypes.map((d, position) => ({ ...d, position })),
      supplementItems: stored.map(({ item, foldedInto }, position) => {
        const { doses: _doses, parts, ...columns } = item;
        return { ...columns, catalogKey: item.catalogKey ?? null, reference: item.reference ?? null, isMix: parts !== undefined, foldedInto, position };
      }),
      supplementDoses: stored.flatMap(({ item }) => item.doses.map((d, position) => ({ itemId: item.id, position, ...d }))),
      supplementMixParts: stored.flatMap(({ item }) =>
        (item.parts ?? []).map((p, position) => ({ mixId: item.id, position, partItemId: p.itemId, name: p.name, ingredients: p.ingredients })),
      ),
      supplementChanges: this.log.map(({ seq, date, type, ...payload }) => ({ seq, date, type, payload })),
    });
  }
}
