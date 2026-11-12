// Lightweight, best-effort localStorage cache for the ONE set currently being typed
// but not yet submitted. Every CONFIRMED set already survives a crash via its own
// immediate POST/PATCH (see WorkoutLogger.tsx handleLog/handleSave) — this module
// exists solely to protect whatever is mid-keystroke in an unlogged WorkingSetRow.
// Deliberately tiny: no TTL, no cross-tab sync, no retry queue. A lost or stale
// draft degrades to "no draft" (falls back to plan defaults) — never a data-loss or
// correctness bug, since the source of truth is always the server record.
//
// The one other thing kept here is a lift occurrence's modification toggles (#1152), under
// `buildModificationsDraftKey`. They decide what the occurrence's next set sends, so the logger
// treats them with more care: logging a set clears them (the logged set then holds them), Finish
// workout sweeps them, and a lost one falls back to the last logged set, then to none.
//
// Storage failures (quota exceeded, disabled storage, corrupted JSON) are handled by
// failing open silently rather than through logClientError — that helper is scoped to
// API mutation failures (see apps/web/lib/log-client-error.ts) and beacons every call;
// routing a per-keystroke local write failure through it would spam a telemetry beacon
// for a benign, expected browser condition rather than a production incident.

import { liftRecordSetSegment, withOccurrence } from '@lifting-logbook/core';

export interface WorkoutSetDraft {
  weight: string;
  reps: string;
  notes: string;
  /**
   * Whether the lifter typed `weight` (#1153). An untyped weight is the plan's, which an `own`
   * toggle can change, so it restores at the current plan. Absent on a draft saved before this
   * existed, which then counts as typed when it differs from the plan.
   */
  weightTyped?: boolean;
}

const KEY_PREFIX = 'workout-draft';

/**
 * A set's draft key. With the macrocycle's stable id it's keyed by that id (#1198), so a draft
 * follows its macrocycle when the number changes and never shows on another macrocycle. Without
 * one it's the key drafts had before, by program and number.
 */
export function buildDraftKey(
  program: string,
  macrocycleNum: number,
  workoutNum: number,
  lift: string,
  setNum: number,
  // Which occurrence of `lift` in the workout (#1027). A first occurrence's key is the
  // one it had before occurrences existed, so a draft typed before this shipped survives.
  occurrence?: number,
  macrocycleId?: string,
): string {
  const set = liftRecordSetSegment({ setNum, ...withOccurrence(occurrence) });
  return macrocycleId
    ? `${KEY_PREFIX}:id:${macrocycleId}:${workoutNum}:${lift}:${set}`
    : `${KEY_PREFIX}:${program}:${macrocycleNum}:${workoutNum}:${lift}:${set}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

// Real runtime narrowing (not a suppression) — validates JSON.parse's `unknown` result
// before trusting its shape, so callers never need an unsafe `as WorkoutSetDraft` cast.
function isDraftShape(value: unknown): value is WorkoutSetDraft {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.weight === 'string' &&
    typeof v.reps === 'string' &&
    typeof v.notes === 'string' &&
    (v.weightTyped === undefined || typeof v.weightTyped === 'boolean')
  );
}

/**
 * The draft at `key`. With no draft there, one saved under `legacyKey` (the number-keyed key a
 * page used before it had the macrocycle's id) is moved to `key` and returned, so a draft typed
 * across the deploy isn't lost (#1198).
 */
export function readDraft(key: string, legacyKey?: string): WorkoutSetDraft | null {
  if (!isBrowser()) return null;
  try {
    let raw = window.localStorage.getItem(key);
    if (raw === null && legacyKey !== undefined) {
      raw = window.localStorage.getItem(legacyKey);
      if (raw !== null) {
        window.localStorage.setItem(key, raw);
        window.localStorage.removeItem(legacyKey);
      }
    }
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraftShape(parsed) ? parsed : null;
  } catch {
    // Corrupted JSON, or localStorage access itself throwing (e.g. SecurityError in a
    // locked-down browser context). Fail open — see module doc comment above.
    return null;
  }
}

export function writeDraft(key: string, draft: WorkoutSetDraft): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // QuotaExceededError or a SecurityError when storage is disabled. Best-effort:
    // proceed without persisting rather than disrupt typing.
  }
}

/**
 * The key of a lift occurrence's toggled modifications, kept beside its set drafts so a toggle
 * changed before a set is logged survives a reload (#1152).
 */
export function buildModificationsDraftKey(
  program: string,
  macrocycleNum: number,
  workoutNum: number,
  lift: string,
  occurrence?: number,
  macrocycleId?: string,
): string {
  return `${buildDraftKey(program, macrocycleNum, workoutNum, lift, 0, occurrence, macrocycleId)}:modifications`;
}

/** The modification ids saved at `key`, or `null` when there are none or they can't be read. */
export function readModificationsDraft(key: string): string[] | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export function writeModificationsDraft(key: string, ids: readonly string[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Same rationale as writeDraft.
  }
}

export function clearDraft(key: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Same rationale as writeDraft.
  }
}
