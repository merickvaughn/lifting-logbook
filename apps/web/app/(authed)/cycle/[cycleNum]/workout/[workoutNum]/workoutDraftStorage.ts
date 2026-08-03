// Lightweight, best-effort localStorage cache for the ONE set currently being typed
// but not yet submitted. Every CONFIRMED set already survives a crash via its own
// immediate POST/PATCH (see WorkoutLogger.tsx handleLog/handleSave) — this module
// exists solely to protect whatever is mid-keystroke in an unlogged WorkingSetRow.
// Deliberately tiny: no TTL, no cross-tab sync, no retry queue. A lost or stale
// draft degrades to "no draft" (falls back to plan defaults) — never a data-loss or
// correctness bug, since the source of truth is always the server record.
//
// Storage failures (quota exceeded, disabled storage, corrupted JSON) are handled by
// failing open silently rather than through logClientError — that helper is scoped to
// API mutation failures (see apps/web/lib/log-client-error.ts) and beacons every call;
// routing a per-keystroke local write failure through it would spam a telemetry beacon
// for a benign, expected browser condition rather than a production incident.

export interface WorkoutSetDraft {
  weight: string;
  reps: string;
  notes: string;
}

const KEY_PREFIX = 'workout-draft';

export function buildDraftKey(
  program: string,
  cycleNum: number,
  workoutNum: number,
  lift: string,
  setNum: number,
): string {
  return `${KEY_PREFIX}:${program}:${cycleNum}:${workoutNum}:${lift}:${setNum}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

// Real runtime narrowing (not a suppression) — validates JSON.parse's `unknown` result
// before trusting its shape, so callers never need an unsafe `as WorkoutSetDraft` cast.
function isDraftShape(value: unknown): value is WorkoutSetDraft {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.weight === 'string' && typeof v.reps === 'string' && typeof v.notes === 'string';
}

export function readDraft(key: string): WorkoutSetDraft | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(key);
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

export function clearDraft(key: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Same rationale as writeDraft.
  }
}
