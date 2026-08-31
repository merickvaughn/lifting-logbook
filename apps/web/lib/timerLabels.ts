import { formatDuration } from '@lifting-logbook/core';
import type { TimerPhase } from '@lifting-logbook/core';

/**
 * Copy shared by the timer page and the workout-detail dock.
 *
 * The two are halves of one session by design — a lifter moves between them
 * mid-workout — so deriving the same four values independently in each let them
 * drift: the overrun-rest button read "Next set" in the dock and "Start next
 * set" on the page, and ending a session was "End timer" in one and "Reset
 * session" in the other. Derive once here instead.
 */

/** The countdown, signed so an overrun reads `+4:03`. */
export function signedTime(remaining: number, overrun: boolean): string {
  return `${overrun ? '+' : ''}${formatDuration(remaining)}`;
}

/** `Paused · Rest`, or just the phase label when running. */
export function phaseLabel(phase: TimerPhase, paused: boolean): string {
  return `${paused ? 'Paused · ' : ''}${phase.label}`;
}

/** What the current phase is for: the set being performed, or what rest precedes. */
export function phaseSubLabel(phase: TimerPhase): string {
  // An activation carries the movement name and no prescription, so the generic
  // `label · spec` form below would render a dangling separator.
  if (phase.kind === 'activation') return phase.set.setLabel;
  if (phase.kind !== 'rest') return `${phase.set.setLabel} · ${phase.set.spec}`;
  return phase.next ? `Up next: ${phase.next.lift} · ${phase.next.setLabel}` : 'Last set done';
}

/** The primary control's label, for both surfaces. */
export function primaryActionLabel(
  running: boolean,
  phase: TimerPhase | null,
  overrun: boolean,
): string {
  if (!running) return 'Start';
  if (phase?.kind !== 'rest') return 'Skip';
  return overrun ? 'Start next set' : 'Skip rest';
}

/**
 * Ending a session clears the run on both surfaces, so it gets one name.
 *
 * "End timer" is kept over the page's old "Reset session" because "reset"
 * suggests returning to the first phase rather than stopping.
 */
export const END_SESSION_LABEL = 'End timer';
