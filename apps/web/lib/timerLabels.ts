import { formatDuration } from '@lifting-logbook/core';
import type { TimerPhase, TimerPhaseKind } from '@lifting-logbook/core';

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

/**
 * Per-kind copy, one entry per `TimerPhaseKind`.
 *
 * Each of these is a `Record` over the kind rather than an `if` chain so that a
 * kind added to `TIMER_PHASE_KINDS` without an entry here is a compile error —
 * the chains these replaced each ended in a fallthrough (`phaseSubLabel` treated
 * anything that wasn't `rest` or `activation` as a set; the queue badge read
 * "Set" for any unknown kind), so a new kind typechecked and rendered as the
 * wrong thing. `timerLabels.test.ts` iterates the array as the runtime check.
 */
const PHASE_SUB_LABEL = {
  prep: (phase) => `${phase.set.setLabel} · ${phase.set.spec}`,
  set: (phase) => `${phase.set.setLabel} · ${phase.set.spec}`,
  // An activation carries the movement name and no prescription, so the
  // `label · spec` form would render a dangling separator.
  activation: (phase) => phase.set.setLabel,
  rest: (phase) =>
    phase.next ? `Up next: ${phase.next.lift} · ${phase.next.setLabel}` : 'Last set done',
} satisfies Record<TimerPhaseKind, (phase: TimerPhase) => string>;

/** What the current phase is for: the set being performed, or what rest precedes. */
export function phaseSubLabel(phase: TimerPhase): string {
  return PHASE_SUB_LABEL[phase.kind](phase);
}

/** The kind badge on a session-queue row. */
export const QUEUE_KIND_LABEL = {
  prep: 'Setup',
  set: 'Set',
  rest: 'Rest',
  activation: 'Activation',
} satisfies Record<TimerPhaseKind, string>;

const QUEUE_ROW_DETAIL = {
  prep: () => '',
  set: (phase) => ` · ${phase.set.spec}`,
  rest: () => '',
  activation: (phase) => ` · ${phase.set.setLabel}`,
} satisfies Record<TimerPhaseKind, (phase: TimerPhase) => string>;

/** What follows the lift name on a session-queue row: the prescription, or the movement. */
export function queueRowDetail(phase: TimerPhase): string {
  return QUEUE_ROW_DETAIL[phase.kind](phase);
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
