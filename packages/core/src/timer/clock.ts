import type { TimerPhase, TimerRunState } from './types';

/**
 * Seconds elapsed in the current phase.
 *
 * Always a wall-clock subtraction — `now - startedAt - pausedMs` — never a sum
 * of ticks. This is the whole reason the timer can promise "lock your phone
 * mid-rest and it keeps counting": a background tab's interval is throttled to
 * once a minute or stopped outright, but the arithmetic here doesn't care how
 * often it was called.
 *
 * `now` is a parameter rather than a `Date.now()` call so this stays pure and
 * so a test can advance the clock without firing the interval.
 */
export function elapsedSeconds(run: TimerRunState, now: number): number {
  const end = run.pausedAt ?? now;
  return Math.max(0, (end - run.startedAt - run.pausedMs) / 1000);
}

/**
 * The phase's effective duration, including any ±30s nudge.
 *
 * The nudge applies to rest only: stretching a working set would misreport time
 * under the bar, which is the one duration the lifter is actually performing.
 */
export function phaseDuration(phase: TimerPhase, run: TimerRunState): number {
  return phase.kind === 'rest' ? Math.max(0, phase.dur + run.bonus) : phase.dur;
}

/**
 * Seconds left in the phase. Negative once the phase has run over, which is a
 * real state rather than an error — rest counts up past zero when `countUp` is
 * on, and the dial renders the overrun as `+M:SS`.
 */
export function phaseRemaining(phase: TimerPhase, run: TimerRunState, now: number): number {
  return phaseDuration(phase, run) - elapsedSeconds(run, now);
}

/**
 * Dial fill, `0`–`1`. Pinned to `1` on overrun so the ring reads full rather
 * than wrapping, and to `1` for a zero-length phase — which is instantly
 * complete, and would otherwise divide by zero.
 */
export function phaseProgress(phase: TimerPhase, run: TimerRunState, now: number): number {
  const dur = phaseDuration(phase, run);
  if (dur <= 0) return 1;
  const left = phaseRemaining(phase, run, now);
  if (left < 0) return 1;
  return Math.min(1, Math.max(0, 1 - left / dur));
}

/**
 * `M:SS` for a second count. Takes the absolute value, so an overrun formats as
 * `4:03` and the caller prefixes the sign — keeping "how long" and "which side
 * of zero" as separate concerns.
 */
export function formatDuration(seconds: number): string {
  const total = Math.abs(Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parses a duration a user typed into a stepper field.
 *
 * Accepts `M:SS` and bare seconds — and only those — since both are natural to
 * type into a box showing `4:00`. Every component must be plain decimal digits.
 * Returns `null` for anything unparseable so the caller can keep the previous
 * value rather than silently resetting the field to zero, which also covers the
 * half-typed `4:` a user passes through on the way to `4:30`.
 */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(':');
  if (parts.length > 2) return null;

  // Accumulate rather than destructure: each part is validated as it is folded
  // in, so there is no partially-parsed intermediate to reason about and no
  // index access to widen.
  let seconds = 0;
  for (const part of parts) {
    // Decimal digits only. `Number` on its own also accepts `0x10` (16), `1e3`
    // (1000), `+5` and `''` (0) — none of which is a duration anyone meant to
    // type, and the exponent form let a typed `1e21` reach storage as a phase
    // that never ends.
    if (!/^\d+$/.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return seconds;
}
