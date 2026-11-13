import { LiftRecord } from '../../models/LiftRecord';
import { TrainingMax } from '../../models/TrainingMax';
import { isNonCycleProgram } from './nonCycle';

/**
 * Splits a validated lift-records batch into two destinations.
 *
 * Rows whose `notes` field mentions a 1RM attempt (case-insensitive "1rm",
 * "1 rm", or "one rep max") are diverted to Training Maxes — the set's `weight`
 * becomes the training max for that lift on that date. All other rows stay in
 * the lift-records bucket. A non-cycle row (a `Program` of `non-cycle`) always stays a set,
 * because a non-cycle workout never changes a training max (#1184).
 *
 * This mirrors the design-of-record in docs/proposals/2026-06-09-smart-file-import.md
 * (Phase 3 — per-row destination disambiguation).
 */
export function splitLiftRecordsByDestination(rows: LiftRecord[]): {
  liftRecords: LiftRecord[];
  trainingMaxes: TrainingMax[];
} {
  const liftRecords: LiftRecord[] = [];
  const trainingMaxes: TrainingMax[] = [];

  for (const r of rows) {
    if (is1RMRow(r) && !isNonCycleProgram(r.program)) {
      trainingMaxes.push({ lift: r.lift, weight: r.weight, dateUpdated: r.date });
    } else {
      liftRecords.push(r);
    }
  }

  return { liftRecords, trainingMaxes };
}

function is1RMRow(r: LiftRecord): boolean {
  const notes = String(r.notes ?? '').toLowerCase();
  return (
    notes.includes('1rm') ||
    notes.includes('1 rm') ||
    notes.includes('one rep max')
  );
}
