import type { SupplementChange, SupplementItem, SupplementReplayAnomalyReason } from '@lifting-logbook/types';
import { parseIsoDate } from '../focus/dates';
import { applyChange, emptyStackState } from './apply';

export type ReplayAnomalyReason = SupplementReplayAnomalyReason;

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

/**
 * Replays the append-only change log to the stack at the end of `date` (`YYYY-MM-DD`), in
 * `(date, seq)` order, with `applyChange`: the same function every write to the stored stack
 * uses, so replay reaches the stack a write saved (ADR-046). Removed items and items folded
 * into a mix are absent; a mix carries its parts. Throws a RangeError when `date` or a change's
 * date isn't an ISO date.
 */
export function stackAsOf(changeLog: readonly SupplementChange[], date: string): StackReplay {
  parseIsoDate(date);
  for (const c of changeLog) parseIsoDate(c.date);

  const ordered = changeLog
    .filter((c) => c.date <= date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));

  const state = emptyStackState();
  const anomalies: ReplayAnomaly[] = [];
  for (const change of ordered) {
    for (const anomaly of applyChange(state, change)) anomalies.push({ change, ...anomaly });
  }
  return { stack: state.items, anomalies };
}
