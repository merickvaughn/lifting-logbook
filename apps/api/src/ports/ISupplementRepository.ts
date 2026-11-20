import { SupplementChange, SupplementDayType, SupplementItem } from '@lifting-logbook/types';

type WithoutSeq<C> = C extends unknown ? Omit<C, 'seq'> : never;
/** A change as the caller builds it; the repository numbers it. */
export type NewSupplementChange = WithoutSeq<SupplementChange>;

/** The supplement stack as stored now (#1374). */
export interface SupplementState {
  /** The stack, in order. */
  items: SupplementItem[];
  /** Items folded into a mix, by the mix's id: kept so splitting the mix brings them back. */
  folded: { item: SupplementItem; mixId: string }[];
  dayTypes: SupplementDayType[];
  /** Null until the user sets one. */
  caffeineCutoff: string | null;
  /** The `seq` the next change appended gets. */
  nextSeq: number;
}

/**
 * Per-user store of the supplement stack and its append-only change log (#1374, ADR-046). The
 * owning userId is bound at construction by the repository factory, as with the other per-user
 * repositories.
 */
export interface ISupplementRepository {
  load(): Promise<SupplementState>;
  /** Every change, in `seq` order. */
  changes(): Promise<SupplementChange[]>;
  /**
   * Replaces the stored state with `next` and appends `changes`, numbered from `next.nextSeq`,
   * all or nothing. Throws `SupplementWriteConflictError` when another write has appended a
   * change since `next.nextSeq` was read.
   */
  save(next: SupplementState, changes: readonly NewSupplementChange[]): Promise<void>;
}
