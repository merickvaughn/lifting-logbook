import { FOCUS_LIMITS, type FocusBlock, type FocusPoolEntry } from '@lifting-logbook/types';
import { lookupByStoredId } from '../catalog/liftIdentity';
import type { LiftRecord } from '../models/LiftRecord';
import { blockRange, toIsoDate } from './dates';

/**
 * A `double` block's pool with each lift's last session recorded on its entry (#1221), or
 * null when nothing changes. `prescribe` progresses from these.
 *
 * A lift's last session is its sets on the latest day inside the block's range and before
 * `today`. Today's sets wait for a later day, so a session in progress never changes its
 * own plan. The entry's `lastReps` become that day's reps in set order, and its `weight`
 * the lightest weight among those sets, so a bump comes only after every set reached
 * `repsHigh` at that weight or above. A session is recorded once, on a day after the
 * entry's `lastDate`: a weight the user edits afterwards stands until the next session.
 *
 * Values are capped at the bounds the focus block DTOs accept, which are tighter than a
 * lift record's, so the pool still saves when the setup page sends it back.
 *
 * A record counts for a pool entry as in `summarizeBlock`: by exact name or the catalog id.
 * The caller passes records whose `lift` holds a custom lift's name, not its id.
 */
export function recordLastSessions(
  block: Pick<FocusBlock, 'start' | 'period' | 'align' | 'progression' | 'pool'>,
  records: readonly LiftRecord[],
  today: string,
): FocusPoolEntry[] | null {
  if (block.progression !== 'double') return null;
  const { start } = blockRange(block);
  const poolLiftFor = lookupByStoredId(block.pool.map((entry) => [entry.lift, entry.lift] as const));
  const latest = new Map<string, { day: string; sets: LiftRecord[] }>();
  for (const record of records) {
    const lift = poolLiftFor(record.lift);
    if (lift === undefined || Number.isNaN(record.date.getTime())) continue;
    const day = toIsoDate(record.date);
    // ISO dates compare correctly as strings.
    if (day < start || day >= today) continue;
    const current = latest.get(lift);
    if (!current || day > current.day) latest.set(lift, { day, sets: [record] });
    else if (day === current.day) current.sets.push(record);
  }

  let changed = false;
  const pool = block.pool.map((entry) => {
    const session = latest.get(entry.lift);
    if (!session || (entry.lastDate !== undefined && session.day <= entry.lastDate)) return entry;
    const sets = [...session.sets]
      .sort((a, b) => a.workoutNum - b.workoutNum || (a.occurrence ?? 0) - (b.occurrence ?? 0) || a.setNum - b.setNum)
      .slice(0, FOCUS_LIMITS.MAX_SETS);
    changed = true;
    return {
      ...entry,
      weight: Math.min(FOCUS_LIMITS.MAX_WEIGHT, ...sets.map((set) => set.weight)),
      lastReps: sets.map((set) => Math.min(FOCUS_LIMITS.MAX_REPS, set.reps)),
      lastDate: session.day,
    };
  });
  return changed ? pool : null;
}

/**
 * `next` with `lastReps` dropped from each entry whose weight was edited away from `prior`'s
 * for the same lift while its `lastReps` came back unchanged, as the setup page sends them:
 * those reps were done at the old weight, and would otherwise bump the new one. `lastDate`
 * stays, so the same session isn't recorded again (#1221).
 */
export function withoutStaleLastReps(prior: readonly FocusPoolEntry[], next: FocusPoolEntry[]): FocusPoolEntry[] {
  const before = new Map(prior.map((entry) => [entry.lift, entry] as const));
  return next.map((entry) => {
    const old = before.get(entry.lift);
    if (!old?.lastReps || entry.lastReps === undefined || entry.weight === old.weight) return entry;
    if (entry.lastReps.join() !== old.lastReps.join()) return entry;
    const { lastReps: _dropped, ...rest } = entry;
    return rest;
  });
}
