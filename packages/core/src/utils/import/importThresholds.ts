import { ImportConfidenceBucket, ImportKind } from '@lifting-logbook/types';

/**
 * Per-type confidence cutoffs for the Smart Import classifier (#477).
 *
 * Each data type carries its own thresholds rather than one global value: a
 * lift-history file and a transposed strength-goals file have very different
 * signal strengths, so a single cutoff would be wrong for at least one. Cutoffs:
 *
 *   - `autoAccept` — at/above this, the wizard routes to the type without asking.
 *     Below it, the Classify step surfaces ranked candidates for a manual pick.
 *   - `high` / `medium` — display buckets (≥ high → 'high', ≥ medium → 'medium',
 *     else 'low'), shown to the user as a confidence badge.
 *
 * Tuned against the committed fixtures; adjust alongside fixture changes.
 */
export const IMPORT_THRESHOLDS: Readonly<
  Record<ImportKind, { autoAccept: number; high: number; medium: number }>
> = {
  'lift-records': { autoAccept: 0.8, high: 0.9, medium: 0.7 },
  'training-maxes': { autoAccept: 0.75, high: 0.88, medium: 0.65 },
  'program-spec': { autoAccept: 0.78, high: 0.9, medium: 0.7 },
  'strength-goals': { autoAccept: 0.65, high: 0.82, medium: 0.55 },
  'complexes': { autoAccept: 0.75, high: 0.88, medium: 0.65 },
};

/** Maps a confidence score to its display bucket using the type's own cutoffs. */
export function bucketConfidence(
  kind: ImportKind,
  confidence: number,
): ImportConfidenceBucket {
  const t = IMPORT_THRESHOLDS[kind];
  if (confidence >= t.high) return 'high';
  if (confidence >= t.medium) return 'medium';
  return 'low';
}

/** True when a score is high enough to auto-route to `kind` without a manual pick. */
export function clearsAutoAccept(kind: ImportKind, confidence: number): boolean {
  return confidence >= IMPORT_THRESHOLDS[kind].autoAccept;
}
