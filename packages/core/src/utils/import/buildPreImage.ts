import {
  LiftRecord,
  LiftingProgramSpec,
  StrengthGoalEntry,
  TrainingMax,
} from '../../models';
import { classifyImportRows } from './classifyAndCount';
import { liftRecordNaturalKey } from './liftRecordNaturalKey';
import {
  latestTrainingMaxFirst,
  programSpecComparable,
  programSpecNaturalKey,
  programSpecRowKind,
  strengthGoalRowKind,
  trainingMaxRowKind,
} from './buildImportPreview';

/**
 * One record's state at import time.
 *
 * `wrote`  — the mutable payload we wrote to the DB; used by the undo
 *             controller as a post-edit guard (if current DB value ≠ wrote,
 *             the user modified the record after the import and undo skips it).
 * `before` — the DB state before the import (undefined for created rows);
 *             used by undo to restore updated records.
 */
export interface PreImageEntry {
  kind: 'created' | 'updated';
  before?: Record<string, unknown>;
  wrote: Record<string, unknown>;
}

/** Snapshot of everything the import wrote, keyed by natural key. */
export type ImportPreImage = Record<string, PreImageEntry>;

/**
 * Build a pre-image for a lift-records batch.
 * Lift records are append-only, so every deduped row is always 'created'.
 */
export function buildLiftRecordsPreImage(created: LiftRecord[]): ImportPreImage {
  const image: ImportPreImage = {};
  const seen = new Set<string>();

  for (const r of created) {
    const key = liftRecordNaturalKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    image[key] = {
      kind: 'created',
      wrote: { weight: r.weight, reps: r.reps, notes: r.notes },
    };
  }

  return image;
}

/**
 * Build a pre-image for a training-maxes batch.
 * Rows that already exist are 'updated'; new lifts are 'created'.
 */
export function buildTrainingMaxPreImage(
  incoming: TrainingMax[],
  existing: TrainingMax[],
): ImportPreImage {
  const existingWeightByLift = new Map(existing.map((m) => [m.lift, m.weight]));
  const existingTmByLift = new Map(existing.map((m) => [m.lift, m]));
  const image: ImportPreImage = {};

  for (const { row: m, kind, key } of classifyImportRows(
    latestTrainingMaxFirst(incoming),
    (m) => m.lift,
    (m) => trainingMaxRowKind(m, existingWeightByLift),
  )) {
    if (kind === 'skip') continue;
    const prior = existingTmByLift.get(key);
    image[key] = {
      kind: kind === 'create' ? 'created' : 'updated',
      ...(prior ? { before: { weight: prior.weight, dateUpdated: prior.dateUpdated.toISOString() } } : {}),
      wrote: { weight: m.weight, dateUpdated: m.dateUpdated.toISOString() },
    };
  }

  return image;
}

/**
 * Build a pre-image for a strength-goals batch.
 * Rows that already exist are 'updated'; new lifts are 'created'.
 */
export function buildStrengthGoalPreImage(
  incoming: StrengthGoalEntry[],
  existing: StrengthGoalEntry[],
): ImportPreImage {
  const existingByLift = new Map(existing.map((g) => [g.lift, g]));
  const image: ImportPreImage = {};

  for (const { row: g, kind, key } of classifyImportRows(
    incoming,
    (g) => g.lift,
    (g) => strengthGoalRowKind(g, existingByLift),
  )) {
    if (kind === 'skip') continue;
    const prior = existingByLift.get(key);
    const snapshot = (e: StrengthGoalEntry): Record<string, unknown> => ({
      goalType: e.goalType,
      target: e.target,
      unit: e.unit,
      ratio: e.ratio,
    });
    image[key] = {
      kind: kind === 'create' ? 'created' : 'updated',
      ...(prior ? { before: snapshot(prior) } : {}),
      wrote: snapshot(g),
    };
  }

  return image;
}

/**
 * Build a pre-image for a program-spec batch.
 * Rows with matching natural keys are 'updated'; new rows are 'created'.
 */
export function buildProgramSpecPreImage(
  incoming: LiftingProgramSpec[],
  existing: LiftingProgramSpec[],
): ImportPreImage {
  const existingByKey = new Map(existing.map((r) => [programSpecNaturalKey(r), r]));
  const image: ImportPreImage = {};

  for (const { row: r, kind, key } of classifyImportRows(
    incoming,
    programSpecNaturalKey,
    (r) => programSpecRowKind(r, existingByKey),
  )) {
    if (kind === 'skip') continue;
    const prior = existingByKey.get(key);
    image[key] = {
      kind: kind === 'create' ? 'created' : 'updated',
      ...(prior ? { before: { comparable: programSpecComparable(prior) } } : {}),
      wrote: { comparable: programSpecComparable(r) },
    };
  }

  return image;
}
