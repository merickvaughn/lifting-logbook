import { ImportDelta, ImportPreview } from '@lifting-logbook/types';
import {
  LiftRecord,
  LiftingProgramSpec,
  StrengthGoalEntry,
  TrainingMax,
} from '../../models';
import { classifyImportRows } from './classifyAndCount';
import { liftRecordNaturalKey } from './liftRecordNaturalKey';
import { normalizeAmrap } from './normalize-amrap';
import { formatDateYYYYMMDD } from '../jsUtil';
import { LiftImportSoftResult } from './validateLiftImportSoft';

/**
 * Pure before→after diff builders for the Smart Import preview step (#477).
 *
 * Each returns `{ creates, updates, skips, deltas }` by comparing the incoming
 * (validated) rows against what is already stored, using the same key each
 * type's write path keys on. No I/O — the caller supplies the existing rows.
 */

function tally(deltas: ImportDelta[]): ImportPreview {
  return {
    creates: deltas.filter((d) => d.kind === 'create').length,
    updates: deltas.filter((d) => d.kind === 'update').length,
    skips: deltas.filter((d) => d.kind === 'skip').length,
    deltas,
  };
}

/**
 * Disambiguates a delta's *display* key when the same natural key is yielded
 * more than once in one preview pass. Since issue #884, `classifyImportRows`
 * yields an in-batch duplicate as an explicit skip (previously dropped
 * silently), so `deltas` can now contain two entries sharing a `key` — and
 * the web import wizard uses `ImportDelta.key` as React list identity and as
 * Set membership for include/exclude selection, both of which require
 * uniqueness (a duplicate key otherwise makes toggling one row also toggle
 * the other, and confuses React's reconciliation). `seenCounts` is scoped to
 * one preview call by the caller; the first occurrence of a key is left
 * unsuffixed so the common (non-duplicate) case is unaffected.
 */
function dedupeDisplayKey(key: string, seenCounts: Map<string, number>): string {
  const count = seenCounts.get(key) ?? 0;
  seenCounts.set(key, count + 1);
  return count === 0 ? key : `${key}#${count}`;
}

/** Natural key for a program-spec row: `week:offset:lift:order`. */
export function programSpecNaturalKey(r: {
  week: number;
  offset: number;
  lift: string;
  order: number;
}): string {
  return `${r.week}:${r.offset}:${r.lift}:${r.order}`;
}

/** Inverse of {@link programSpecNaturalKey}. Returns null for malformed keys. */
export function parseProgramSpecNaturalKey(
  key: string,
): { week: number; offset: number; lift: string; order: number } | null {
  const parts = key.split(':');
  if (parts.length < 4) return null;
  const week = parseInt(parts[0] ?? '', 10);
  const offset = parseInt(parts[1] ?? '', 10);
  const order = parseInt(parts[parts.length - 1] ?? '', 10);
  const lift = parts.slice(2, parts.length - 1).join(':');
  if (isNaN(week) || isNaN(offset) || isNaN(order) || !lift) return null;
  return { week, offset, lift, order };
}

/**
 * Lift records are append-only: a row either creates (new natural key) or skips
 * (key already present, whether already stored or repeated earlier in this
 * same file — issue #884 — both surface as a 'skip' delta).
 */
export function buildLiftRecordsPreview(
  incoming: LiftRecord[],
  existing: LiftRecord[],
): ImportPreview {
  const existingKeys = new Set(existing.map(liftRecordNaturalKey));
  const deltas: ImportDelta[] = [];
  const seenCounts = new Map<string, number>();

  for (const { row: r, kind, key } of classifyImportRows(
    incoming,
    liftRecordNaturalKey,
    (_r, k) => (existingKeys.has(k) ? 'skip' : 'create'),
  )) {
    const displayKey = dedupeDisplayKey(key, seenCounts);
    const label = `${r.lift} · cycle ${r.cycleNum} workout ${r.workoutNum} set ${r.setNum} (${formatDateYYYYMMDD(r.date)})`;
    const value = `${r.weight} × ${r.reps}`;
    deltas.push(
      kind === 'skip'
        ? { key: displayKey, label, kind, before: value, after: value }
        : { key: displayKey, label, kind, after: value },
    );
  }
  return tally(deltas);
}

/**
 * Phase 3: lift-records preview that includes soft-validation rows (incomplete /
 * ambiguous) with status tags, enabling the interactive REVIEW step. Valid rows
 * are classified as create/skip; incomplete and ambiguous rows appear as 'create'
 * with their respective status so the REVIEW step can offer in-line fixes.
 */
export function buildLiftRecordsPreviewSoft(
  softResult: LiftImportSoftResult,
  existing: LiftRecord[],
): ImportPreview {
  const existingKeys = new Set(existing.map(liftRecordNaturalKey));
  const deltas: ImportDelta[] = [];
  const seenCounts = new Map<string, number>();

  // Valid rows — normal create/skip classification
  for (const { row: r, kind, key } of classifyImportRows(
    softResult.valid,
    liftRecordNaturalKey,
    (_r, k) => (existingKeys.has(k) ? 'skip' : 'create'),
  )) {
    const displayKey = dedupeDisplayKey(key, seenCounts);
    const label = `${r.lift} · cycle ${r.cycleNum} workout ${r.workoutNum} set ${r.setNum} (${formatDateYYYYMMDD(r.date)})`;
    const value = `${r.weight} × ${r.reps}`;
    deltas.push(
      kind === 'skip'
        ? { key: displayKey, label, kind, before: value, after: value }
        : { key: displayKey, label, kind, after: value },
    );
  }

  // Incomplete rows — tag with status so REVIEW can filter/highlight them
  for (const { rowIndex } of softResult.incomplete) {
    const key = `__incomplete_${rowIndex}`;
    const label = `Row ${rowIndex} (incomplete)`;
    deltas.push({ key, label, kind: 'create', status: 'incomplete', rowIndex });
  }

  // Ambiguous rows — tag with status and original lift name for autocomplete
  for (const { record: r, rowIndex, originalLift } of softResult.ambiguous) {
    const key = `__ambiguous_${rowIndex}`;
    const value = `${r.weight} × ${r.reps}`;
    const label = `${originalLift} · cycle ${r.cycleNum} workout ${r.workoutNum} set ${r.setNum} (${formatDateYYYYMMDD(r.date)})`;
    deltas.push({
      key,
      label,
      kind: 'create',
      after: value,
      status: 'ambiguous',
      rowIndex,
      originalLift,
    });
  }

  return tally(deltas);
}

/**
 * Outcome of importing a single (deduped) upsert-by-lift row against stored data.
 * The create/update/skip *decision* lives here so the preview builders and the
 * repository commit methods classify identically — preview and commit can never
 * disagree on the counts (issue #488).
 */
export type ImportRowKind = 'create' | 'update' | 'skip';

/** Classify one training-max row vs the stored maxes (keyed by lift). */
export function trainingMaxRowKind(
  m: TrainingMax,
  existingByLift: Map<string, number>,
): ImportRowKind {
  const before = existingByLift.get(m.lift);
  if (before === undefined) return 'create';
  // Both sides are numeric weights (Float -> number); compare numerically rather
  // than by string coercion, which would misclassify e.g. 300.10 vs 300.1 as an
  // update. The string form is only needed for the before/after display values.
  return before === m.weight ? 'skip' : 'update';
}

/** Classify one strength-goal row vs the stored goals (keyed by lift). */
export function strengthGoalRowKind(
  g: StrengthGoalEntry,
  existingByLift: Map<string, StrengthGoalEntry>,
): ImportRowKind {
  const prior = existingByLift.get(g.lift);
  if (!prior) return 'create';
  return goalValue(prior) === goalValue(g) ? 'skip' : 'update';
}

/** Training maxes upsert by `lift`: create if absent, update if the weight differs, else skip. */
export function buildTrainingMaxPreview(
  incoming: TrainingMax[],
  existing: TrainingMax[],
): ImportPreview {
  const existingByLift = new Map(existing.map((m) => [m.lift, m.weight]));
  const deltas: ImportDelta[] = [];
  const seenCounts = new Map<string, number>();

  for (const { row: m, kind, key } of classifyImportRows(
    incoming,
    (m) => m.lift,
    (m) => trainingMaxRowKind(m, existingByLift),
  )) {
    const displayKey = dedupeDisplayKey(key, seenCounts);
    const after = `${m.weight}`;
    const before = existingByLift.get(m.lift);
    deltas.push(
      before === undefined
        ? { key: displayKey, label: m.lift, kind, after }
        : { key: displayKey, label: m.lift, kind, before: `${before}`, after },
    );
  }
  return tally(deltas);
}

function goalValue(g: StrengthGoalEntry): string {
  return g.goalType === 'relative'
    ? `${g.ratio}× bodyweight`
    : `${g.target} ${g.unit}`;
}

/** Strength goals upsert by `lift`: create if absent, update if any field differs, else skip. */
export function buildStrengthGoalPreview(
  incoming: StrengthGoalEntry[],
  existing: StrengthGoalEntry[],
): ImportPreview {
  const existingByLift = new Map(existing.map((g) => [g.lift, g]));
  const deltas: ImportDelta[] = [];
  const seenCounts = new Map<string, number>();

  for (const { row: g, kind, key } of classifyImportRows(
    incoming,
    (g) => g.lift,
    (g) => strengthGoalRowKind(g, existingByLift),
  )) {
    const displayKey = dedupeDisplayKey(key, seenCounts);
    const after = goalValue(g);
    const prior = existingByLift.get(g.lift);
    deltas.push(
      prior
        ? { key: displayKey, label: g.lift, kind, before: goalValue(prior), after }
        : { key: displayKey, label: g.lift, kind, after },
    );
  }
  return tally(deltas);
}

function specValue(r: LiftingProgramSpec): string {
  const amrap = normalizeAmrap(r.amrap) ? ' AMRAP' : '';
  return `${r.sets}×${r.reps}${amrap} @ ${r.warmUpPct}`;
}

/**
 * Canonical serialization of a program-spec row's writable fields (everything
 * except its natural key). Preview and commit both compare on this string so the
 * "update vs skip" decision is identical in both places.
 */
export function programSpecComparable(r: LiftingProgramSpec): string {
  const amrap = normalizeAmrap(r.amrap);
  return JSON.stringify({
    increment: r.increment,
    sets: r.sets,
    reps: r.reps,
    amrap,
    warmUpPct: r.warmUpPct,
    wtDecrementPct: r.wtDecrementPct,
    activation: r.activation,
    weekType: r.weekType ?? null,
  });
}

/** Classify one program-spec row vs the stored rows (keyed by natural key). */
export function programSpecRowKind(
  r: LiftingProgramSpec,
  existingByKey: Map<string, LiftingProgramSpec>,
): ImportRowKind {
  const prior = existingByKey.get(programSpecNaturalKey(r));
  if (!prior) return 'create';
  return programSpecComparable(prior) === programSpecComparable(r) ? 'skip' : 'update';
}

/** Program-spec rows upsert by natural key: create if absent, update if config differs, else skip. */
export function buildProgramSpecPreview(
  incoming: LiftingProgramSpec[],
  existing: LiftingProgramSpec[],
): ImportPreview {
  const existingByKey = new Map(existing.map((r) => [programSpecNaturalKey(r), r]));
  const deltas: ImportDelta[] = [];
  const seenCounts = new Map<string, number>();

  for (const { row: r, kind, key } of classifyImportRows(
    incoming,
    programSpecNaturalKey,
    (r) => programSpecRowKind(r, existingByKey),
  )) {
    // Lookup uses the true natural key `key`, not the disambiguated display
    // key below — an in-batch duplicate still describes the same stored (or
    // about-to-be-created) spec row as its first occurrence.
    const prior = existingByKey.get(key);
    const displayKey = dedupeDisplayKey(key, seenCounts);
    const label = `Week ${r.week} · ${r.lift} (#${r.order})`;
    const after = specValue(r);
    deltas.push(
      prior
        ? { key: displayKey, label, kind, before: specValue(prior), after }
        : { key: displayKey, label, kind, after },
    );
  }
  return tally(deltas);
}
