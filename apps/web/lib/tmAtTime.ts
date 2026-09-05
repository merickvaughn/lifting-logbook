import type { TrainingMaxHistoryEntryResponse } from '@lifting-logbook/types';

export interface TmAtTimeIndex {
  /** The training-max entry in force for `lift` on `date` (ISO `YYYY-MM-DD`), or `null`. */
  find(lift: string, date: string): TrainingMaxHistoryEntryResponse | null;
}

/**
 * Builds a per-lift lookup once, so the history page resolves "the training
 * max in force on this record's date" for every record in O(entries for that
 * lift) instead of re-filtering and re-sorting the whole history per record
 * (issue #981).
 *
 * Equivalent to the inline form it replaces —
 * `entries.filter((e) => e.lift === lift && e.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0]`
 * — including its tie behaviour: each group is the API order narrowed to one
 * lift and sorted once with the same comparator; `Array.prototype.sort` is
 * stable, so among equal dates the API order wins in both, and the first entry
 * passing `<=` on the descending scan is exactly the `[0]` the original picked.
 * (The API-side tie order itself is #908's concern, not this helper's.)
 *
 * A linear scan rather than a binary search on purpose: `<=` and
 * `localeCompare` only agree for ISO dates, and the original assumed nothing
 * about the strings beyond what those two operators do.
 */
export function buildTmAtTimeIndex(
  entries: readonly TrainingMaxHistoryEntryResponse[],
): TmAtTimeIndex {
  const byLift = new Map<string, TrainingMaxHistoryEntryResponse[]>();
  for (const entry of entries) {
    const group = byLift.get(entry.lift);
    if (group) group.push(entry);
    else byLift.set(entry.lift, [entry]);
  }
  for (const group of byLift.values()) {
    group.sort((a, b) => b.date.localeCompare(a.date));
  }
  return {
    find(lift, date) {
      const group = byLift.get(lift);
      if (!group) return null;
      for (const entry of group) {
        if (entry.date <= date) return entry;
      }
      return null;
    },
  };
}
