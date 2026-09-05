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

import {
  isTimerPhaseKey,
  normalizeClassifications,
  normalizeTimerSettings,
} from '@lifting-logbook/core';
import type { TimerRunState, TimerSettings, TimerWorkoutKey } from '@lifting-logbook/core';

/** Versioned so a future schema change can migrate rather than clobber. */
export const TIMER_STORAGE_KEY = 'll.timer.v1';

/**
 * Shape version of the *queue* a persisted run's `idx` addresses.
 *
 * `TimerRunState.idx` is a bare index into the built queue, and the queue's shape
 * is derived from code, not from anything stored — so a release that changes how
 * many phases a set expands to silently re-points every in-flight run. Adding the
 * activation phase (#960) did exactly that: a run recorded at the index of
 * `Set 1` resumes on the activation that now precedes it, and `startedAt` is
 * carried over, so elapsed time recorded against a 60 s set is applied to a
 * 240 s rest.
 *
 * The re-anchor effect in `useWorkoutTimer` cannot catch this — it compares the
 * queue against the *previous render's* queue, which on a fresh mount is already
 * the new shape, so it re-finds and then cements the displaced phase.
 *
 * Bump this whenever a change alters the phases `buildTimerQueue` emits for a
 * given plan, or changes what a run needs in order to be re-anchored (shape 3
 * added the persisted `on` key — issue #980). A run written under a different
 * version is dropped rather than resumed at the wrong phase: a run is minutes of
 * ephemeral position (the lifter taps Start again), whereas a silently wrong
 * countdown is indistinguishable from a working one. Settings are stored beside
 * it and are unaffected — they migrate field-by-field through
 * `normalizeTimerSettings` instead.
 */
export const TIMER_RUN_SHAPE = 3;

interface StoredBlob {
  settings: unknown;
  run: unknown;
  /** {@link TIMER_RUN_SHAPE} at the time `run` was written. Absent pre-#960. */
  runShape?: unknown;
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
    return {
      settings: parsed.settings ?? null,
      run: parsed.run ?? null,
      runShape: parsed.runShape,
    };
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
  const previous = readBlob();
  writeBlob({ settings, run: previous.run, runShape: previous.runShape });
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
 * `TimerRunState`, minus the one field {@link isRunShape} does not validate.
 *
 * `classifications` is deliberately not checked by that guard — a run persisted
 * before that field existed, or one whose value is malformed, still passes.
 * Narrowing to this type instead of `TimerRunState` makes that gap something
 * the compiler enforces rather than something only this comment says: reading
 * `.classifications` off a value `isRunShape` alone narrowed is a type error,
 * not just a documented mistake, and every caller is routed through
 * `normalizeClassifications` (see `loadTimerRun`) to get a real value.
 */
type UnvalidatedRun = Omit<TimerRunState, 'classifications'> & { classifications?: unknown };

/**
 * Runtime narrowing rather than a cast — a persisted run drives array indexing
 * and arithmetic the moment it is restored, so an unvalidated shape would surface
 * as a crash or a frozen dial rather than as a type error.
 *
 * Narrows to {@link UnvalidatedRun}, not `TimerRunState` — see that type's doc
 * for why `classifications` is excluded. `loadTimerRun` closes the gap
 * immediately afterward by overwriting it with `normalizeClassifications`'s
 * output, the same always-succeeds contract `normalizeTimerSettings` already
 * gives the settings half of this blob.
 */
function isRunShape(value: unknown): value is UnvalidatedRun {
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
    isWorkoutKey(value.workout) &&
    // The anchor is what a rebuilt queue re-derives `idx` from, so a run
    // without a valid one cannot be placed and is dropped (issue #980).
    isTimerPhaseKey(value.on)
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
  const blob = readBlob();
  // A run whose `idx` was recorded against a different queue shape addresses a
  // different phase now — see TIMER_RUN_SHAPE. Dropped rather than resumed, and
  // checked before the shape guard so a stale run never reaches the arithmetic.
  if (blob.runShape !== TIMER_RUN_SHAPE) return null;
  const run = blob.run;
  if (!isRunShape(run)) return null;
  if (!sameWorkout(run.workout, workout)) return null;
  // `run` is `UnvalidatedRun` here — `.classifications` is `unknown`, not yet a
  // real value. This is what makes it one.
  return { ...run, classifications: normalizeClassifications(run.classifications) };
}

/** Persists the run, leaving settings untouched. `null` ends the session. */
export function saveTimerRun(run: TimerRunState | null): void {
  writeBlob({ settings: readBlob().settings, run, runShape: TIMER_RUN_SHAPE });
}
