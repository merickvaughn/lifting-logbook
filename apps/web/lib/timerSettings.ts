// Persistence for the rest timer: durations, behavior flags, and the in-flight run.
//
// One versioned localStorage key holds all of it, which is what lets the timer page
// and the workout-detail dock share a live run with no server round-trip — navigate
// between them and the countdown continues. `normalizeTimerSettings` in
// @lifting-logbook/core treats whatever comes back as untrusted, so a hand-edited,
// truncated, or older-schema blob degrades to working defaults rather than to a
// dial rendering NaN.
//
// This module is deliberately the ONLY seam that touches storage, so moving timer
// settings server-side later (issue #958's follow-up) is a one-file change: swap the
// bodies here for api-client calls and every caller is unaffected.
//
// Storage failures (quota exceeded, disabled storage, corrupted JSON) fail open
// silently rather than routing through logClientError — that helper is scoped to API
// mutation failures and beacons every call, so sending it a benign browser condition
// would spam telemetry for something that is not a production incident. Same
// rationale, and the same shape, as workoutDraftStorage.ts.

import { normalizeTimerSettings } from '@lifting-logbook/core';
import type { TimerRunState, TimerSettings, TimerWorkoutKey } from '@lifting-logbook/core';

/** Versioned so a future schema change can migrate rather than clobber. */
export const TIMER_STORAGE_KEY = 'll.timer.v1';

interface StoredBlob {
  settings: unknown;
  run: unknown;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBlob(): StoredBlob {
  if (!isBrowser()) return { settings: null, run: null };
  try {
    const raw = window.localStorage.getItem(TIMER_STORAGE_KEY);
    if (raw === null) return { settings: null, run: null };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { settings: null, run: null };
    return { settings: parsed.settings ?? null, run: parsed.run ?? null };
  } catch {
    // Corrupted JSON, or localStorage access itself throwing (e.g. SecurityError in
    // a locked-down browser context). Fail open — see module doc comment above.
    return { settings: null, run: null };
  }
}

function writeBlob(blob: StoredBlob): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    // QuotaExceededError, or a SecurityError when storage is disabled. Best-effort:
    // the timer keeps running from memory, it just won't survive a reload.
  }
}

/** Settings as persisted, normalized to a complete, usable blob. Never throws. */
export function loadTimerSettings(): TimerSettings {
  return normalizeTimerSettings(readBlob().settings);
}

/** Persists settings, leaving any in-flight run untouched. */
export function saveTimerSettings(settings: TimerSettings): void {
  writeBlob({ settings, run: readBlob().run });
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

function isWorkoutKey(value: unknown): value is TimerWorkoutKey {
  if (!isRecord(value)) return false;
  return (
    typeof value.program === 'string' &&
    typeof value.cycleNum === 'number' &&
    typeof value.workoutNum === 'number'
  );
}

/**
 * Runtime narrowing rather than a cast — a persisted run drives array indexing
 * and arithmetic the moment it is restored, so an unvalidated shape would surface
 * as a crash or a frozen dial rather than as a type error.
 */
function isRunShape(value: unknown): value is TimerRunState {
  if (!isRecord(value)) return false;
  return (
    typeof value.idx === 'number' &&
    Number.isInteger(value.idx) &&
    value.idx >= 0 &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    typeof value.pausedMs === 'number' &&
    Number.isFinite(value.pausedMs) &&
    (value.pausedAt === null ||
      (typeof value.pausedAt === 'number' && Number.isFinite(value.pausedAt))) &&
    typeof value.bonus === 'number' &&
    Number.isFinite(value.bonus) &&
    isWorkoutKey(value.workout)
  );
}

export function sameWorkout(a: TimerWorkoutKey, b: TimerWorkoutKey): boolean {
  return a.program === b.program && a.cycleNum === b.cycleNum && a.workoutNum === b.workoutNum;
}

/**
 * The persisted run, but only if it belongs to `workout`.
 *
 * A run left behind on Tuesday's session must not resurrect the dock on
 * Thursday's — the workout key is what makes "shared across routes" mean
 * "shared across routes *for this workout*".
 */
export function loadTimerRun(workout: TimerWorkoutKey): TimerRunState | null {
  const run = readBlob().run;
  if (!isRunShape(run)) return null;
  return sameWorkout(run.workout, workout) ? run : null;
}

/** Persists the run, leaving settings untouched. `null` ends the session. */
export function saveTimerRun(run: TimerRunState | null): void {
  writeBlob({ settings: readBlob().settings, run });
}
