import { TIMER_PHASE_KINDS } from './types';
import type { TimerPhase, TimerPhaseKey, TimerPhaseKind } from './types';

/**
 * Ordering and re-anchoring over {@link TimerPhaseKey}.
 *
 * `liftIndex` is positional on purpose: one workout can hold the same lift
 * twice (the program editor keys an instance by position, never by name), and
 * a name-based key resolves both occurrences to the first (issue #971). The
 * activation phase precedes every set of its lift, so it carries
 * `setOrdinal: -1` — which is also what makes {@link comparePhaseKeys} put it
 * first, matching the order `buildTimerQueue` emits.
 */

/** Order of a set's phases as the queue emits them. */
const KIND_RANK: Record<TimerPhaseKind, number> = {
  activation: 0,
  prep: 1,
  set: 2,
  rest: 3,
};

export function phaseKey(phase: TimerPhase): TimerPhaseKey {
  return { liftIndex: phase.liftIndex, setOrdinal: phase.setOrdinal, kind: phase.kind };
}

export function sameTimerPhaseKey(a: TimerPhaseKey, b: TimerPhaseKey): boolean {
  return a.liftIndex === b.liftIndex && a.setOrdinal === b.setOrdinal && a.kind === b.kind;
}

/**
 * The total order {@link buildTimerQueue} emits phases in: by lift occurrence,
 * then by set, then activation < prep < set < rest. Because the activation's
 * ordinal is `-1`, it sorts before the lift's first set with no special case.
 */
export function comparePhaseKeys(a: TimerPhaseKey, b: TimerPhaseKey): number {
  return (
    a.liftIndex - b.liftIndex ||
    a.setOrdinal - b.setOrdinal ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind]
  );
}

/**
 * Where a run anchored on `key` belongs in a (possibly rebuilt) queue.
 *
 * Exact match first — the phase is still there, perhaps at a new index, and the
 * run's clock carries on. Otherwise the phase was removed by the rebuild (its
 * duration went to zero, its warm-up was skipped away) and the run should
 * *advance* to the nearest surviving phase at or after it in emission order,
 * not end (issue #972). `index` is `-1` only when nothing survives at or after
 * the key, which is the one case where ending the session is right.
 *
 * The queue is emitted in key order, so the first phase comparing greater is
 * the nearest survivor; no sort is needed.
 */
export function reanchorIndex(
  queue: readonly TimerPhase[],
  key: TimerPhaseKey,
): { index: number; exact: boolean } {
  const exact = queue.findIndex((phase) => sameTimerPhaseKey(phaseKey(phase), key));
  if (exact !== -1) return { index: exact, exact: true };
  const next = queue.findIndex((phase) => comparePhaseKeys(phaseKey(phase), key) > 0);
  return { index: next, exact: false };
}

function isKind(value: unknown): value is TimerPhaseKind {
  return typeof value === 'string' && (TIMER_PHASE_KINDS as readonly string[]).includes(value);
}

/**
 * Runtime guard for a key read back from storage — a persisted run's anchor
 * drives array indexing the moment it is restored, so an unvalidated shape
 * would surface as a crash or a frozen dial rather than as a type error.
 * `setOrdinal` may be `-1` (an activation) but nothing below that.
 */
export function isTimerPhaseKey(raw: unknown): raw is TimerPhaseKey {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return (
    typeof value.liftIndex === 'number' &&
    Number.isInteger(value.liftIndex) &&
    value.liftIndex >= 0 &&
    typeof value.setOrdinal === 'number' &&
    Number.isInteger(value.setOrdinal) &&
    value.setOrdinal >= -1 &&
    isKind(value.kind)
  );
}
