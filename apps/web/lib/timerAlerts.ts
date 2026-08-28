// Browser-API wrappers for the rest timer's end-of-phase alerts and screen wake lock.
//
// Every one of these is optional by nature: audio needs a user gesture and can be
// refused, vibration is a no-op on desktop, and wake lock is unsupported in several
// browsers and revoked whenever the page hides. So each wrapper is feature-detected
// and fails silently — a lifter whose browser refuses a wake lock should still get a
// working countdown, not an error surface.
//
// Failures are NOT routed through logClientError: that helper is scoped to API
// mutation failures and beacons every call, and a denied permission is a normal
// browser condition rather than a production incident. Same rationale as
// workoutDraftStorage.ts and timerSettings.ts.

import type { TimerAlertMode } from '@lifting-logbook/core';

type AudioContextCtor = typeof AudioContext;

interface WebkitWindow {
  webkitAudioContext?: AudioContextCtor;
}

let audioContext: AudioContext | null = null;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.AudioContext !== 'undefined') return window.AudioContext;
  // Safari < 14.1 still exposes only the prefixed constructor.
  const webkit = (window as unknown as WebkitWindow).webkitAudioContext;
  return webkit ?? null;
}

/**
 * Lazily creates the shared AudioContext.
 *
 * Must first be called from inside a user gesture — browsers start a context
 * created outside one in the `suspended` state, and a suspended context plays
 * nothing. The Start button calls {@link beep} for exactly this reason.
 */
function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  const Ctor = resolveAudioContextCtor();
  if (!Ctor) return null;
  try {
    audioContext = new Ctor();
    return audioContext;
  } catch {
    return null;
  }
}

/** True when the mode calls for an audible alert. */
function wantsBeep(mode: TimerAlertMode): boolean {
  return mode === 'Both' || mode === 'Beep';
}

/** True when the mode calls for haptics. */
function wantsBuzz(mode: TimerAlertMode): boolean {
  return mode === 'Both' || mode === 'Vibrate';
}

/**
 * A short sine tone.
 *
 * Gain is ramped exponentially rather than switched, because an instant
 * amplitude step produces an audible click at both ends of the tone. The ramp
 * floor is 0.0001 rather than 0 — `exponentialRampToValueAtTime` rejects a
 * target of zero.
 */
export function beep(mode: TimerAlertMode, frequency: number, ms: number): void {
  if (!wantsBeep(mode)) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    // A context created before the first gesture, or auto-suspended on tab hide,
    // resumes here rather than silently playing nothing.
    if (ctx.state === 'suspended') void ctx.resume();

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.connect(ctx.destination);

    const seconds = ms / 1000;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + seconds);

    oscillator.start();
    oscillator.stop(ctx.currentTime + seconds + 0.02);
  } catch {
    // Audio is an enhancement; a refused or exhausted context must not break the tick.
  }
}

/** A vibration pattern, where supported and enabled. */
export function buzz(mode: TimerAlertMode, pattern: number | number[]): void {
  if (!wantsBuzz(mode)) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Ignored by design — desktop browsers and locked-down contexts both no-op here.
  }
}

// ---------------------------------------------------------------------------
// Screen wake lock
// ---------------------------------------------------------------------------

/**
 * Requests a screen wake lock, returning the sentinel or `null`.
 *
 * Callers must re-request on `visibilitychange`: per the Screen Wake Lock spec
 * (§3.3), the lock is released whenever the document becomes hidden, and it is
 * NOT restored when the document becomes visible again. Acquiring once at the
 * start of a session would therefore stop working after the first tab switch.
 */
export async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null;
  try {
    return await navigator.wakeLock.request('screen');
  } catch {
    // NotAllowedError when the document is hidden or the battery is low. The timer
    // still keeps correct time — only the screen dims.
    return null;
  }
}

/** Releases a sentinel, tolerating one that the browser already revoked. */
export async function releaseWakeLock(sentinel: WakeLockSentinel | null): Promise<void> {
  if (!sentinel) return;
  try {
    await sentinel.release();
  } catch {
    // Already released by the browser (tab hidden, screen off). Nothing to do.
  }
}
