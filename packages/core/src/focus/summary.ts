import type { FocusBlock } from '@lifting-logbook/types';
import { lookupByStoredId } from '../catalog/liftIdentity';
import type { LiftRecord } from '../models/LiftRecord';
import { blockRange, toIsoDate } from './dates';

/** A pool lift's best set inside a block, beating its best before the block. */
export interface FocusPr {
  lift: string;
  weight: number;
  reps: number;
  previousWeight: number;
  previousReps: number;
}

export interface FocusBlockSummary {
  /** Distinct days with at least one pool-lift set. */
  sessions: number;
  sets: number;
  /** Sum of weight × reps. */
  volume: number;
  prs: FocusPr[];
}

type BestSet = Pick<LiftRecord, 'weight' | 'reps'>;

/** Heavier wins; at equal weight, more reps wins. */
function beats(a: BestSet, b: BestSet): boolean {
  return a.weight > b.weight || (a.weight === b.weight && a.reps > b.reps);
}

/**
 * Totals for a block from the user's lift records: every set of a pool lift dated inside
 * the block's range. A record's day is the UTC calendar day of its `date`, which is stored
 * at UTC midnight. A PR is a lift whose best set in the range beats its best set before the
 * range; a lift with no earlier history has nothing to beat, so it never counts as one.
 *
 * A record counts for the pool entry with its exact name, or through the catalog id (#1135),
 * so `bench-press` counts for `Bench Press`. Two names stay apart: a program can plan
 * `C. Lat Raise` separately from a pool's `Lateral Raise`, and history keeps them apart too.
 * The caller passes records whose `lift` holds a custom lift's name, not its id. Records with
 * an invalid date are ignored.
 */
export function summarizeBlock(
  records: readonly LiftRecord[],
  block: Pick<FocusBlock, 'start' | 'period' | 'align' | 'pool'>,
): FocusBlockSummary {
  const { start, end } = blockRange(block);
  const poolLifts = new Set(block.pool.map((entry) => entry.lift));
  const poolLiftFor = lookupByStoredId([...poolLifts].map((lift) => [lift, lift] as const));
  const days = new Set<string>();
  const bestBefore = new Map<string, BestSet>();
  const bestDuring = new Map<string, BestSet>();
  let sets = 0;
  let volume = 0;

  for (const record of records) {
    const poolLift = poolLiftFor(record.lift);
    if (poolLift === undefined || Number.isNaN(record.date.getTime())) continue;
    const day = toIsoDate(record.date);
    // ISO dates compare correctly as strings.
    if (day > end) continue;
    const before = day < start;
    const best = before ? bestBefore : bestDuring;
    const current = best.get(poolLift);
    if (!current || beats(record, current)) best.set(poolLift, record);
    if (before) continue;
    days.add(day);
    sets += 1;
    volume += record.weight * record.reps;
  }

  const prs: FocusPr[] = [];
  for (const lift of poolLifts) {
    const during = bestDuring.get(lift);
    const before = bestBefore.get(lift);
    if (during && before && beats(during, before)) {
      prs.push({
        lift,
        weight: during.weight,
        reps: during.reps,
        previousWeight: before.weight,
        previousReps: before.reps,
      });
    }
  }

  return { sessions: days.size, sets, volume, prs };
}
