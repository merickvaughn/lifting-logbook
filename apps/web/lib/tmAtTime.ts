import { liftIdFor } from '@lifting-logbook/core';
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
 *
 * The lift can be spelled differently on each side (#1135), and this follows the rule
 * `currentMaxLookup` applies to the current max: entries under the exact name and under
 * the catalog id compete, the more recent one winning and a tie going to the exact name.
 * An entry under another name applies only when neither has one.
 */
export function buildTmAtTimeIndex(
  entries: readonly TrainingMaxHistoryEntryResponse[],
): TmAtTimeIndex {
  const byLift = new Map<string, TrainingMaxHistoryEntryResponse[]>();
  const byId = new Map<string, TrainingMaxHistoryEntryResponse[]>();
  const addTo = (
    groups: Map<string, TrainingMaxHistoryEntryResponse[]>,
    key: string,
    entry: TrainingMaxHistoryEntryResponse,
  ) => {
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  };
  for (const entry of entries) {
    addTo(byLift, entry.lift, entry);
    addTo(byId, liftIdFor(entry.lift), entry);
  }
  for (const groups of [byLift, byId]) {
    for (const group of groups.values()) {
      group.sort((a, b) => b.date.localeCompare(a.date));
    }
  }
  return {
    find(lift, date) {
      const inForce = (group: readonly TrainingMaxHistoryEntryResponse[] | undefined) => {
        for (const entry of group ?? []) {
          if (entry.date <= date) return entry;
        }
        return null;
      };
      const id = liftIdFor(lift);
      const exact = inForce(byLift.get(lift));
      const stored = inForce(byLift.get(id));
      if (exact && stored) return stored.date.localeCompare(exact.date) > 0 ? stored : exact;
      return exact ?? stored ?? inForce(byId.get(id));
    },
  };
}
