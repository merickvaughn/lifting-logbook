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
  return {
    liftIndex: phase.liftIndex,
    setOrdinal: phase.setOrdinal,
    kind: phase.kind,
    lift: phase.lift,
  };
}

export function sameTimerPhaseKey(a: TimerPhaseKey, b: TimerPhaseKey): boolean {
  return (
    a.liftIndex === b.liftIndex &&
    a.setOrdinal === b.setOrdinal &&
    a.kind === b.kind &&
    a.lift === b.lift
  );
}

/** Positional order of a phase relative to a key; the name plays no part. */
function comparePosition(
  a: Pick<TimerPhaseKey, 'liftIndex' | 'setOrdinal' | 'kind'>,
  b: Pick<TimerPhaseKey, 'liftIndex' | 'setOrdinal' | 'kind'>,
): number {
  return (
    a.liftIndex - b.liftIndex ||
    a.setOrdinal - b.setOrdinal ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind]
  );
}

/**
 * The total order {@link buildTimerQueue} emits phases in: by lift occurrence,
 * then by set, then activation < prep < set < rest. Because the activation's
 * ordinal is `-1`, it sorts before the lift's first set with no special case.
 * `lift` is not part of the order — see {@link TimerPhaseKey.lift}.
 */
export function comparePhaseKeys(a: TimerPhaseKey, b: TimerPhaseKey): number {
  return comparePosition(a, b);
}

/**
 * Where a run anchored on `key` belongs in a (possibly rebuilt) queue.
 *
 * Exact match first — the phase is still there, perhaps at a new index, and the
 * run's clock carries on. Otherwise the phase was removed by the rebuild (its
 * duration went to zero, its warm-up was skipped away) and the run should
 * *advance* to the nearest surviving phase after it in emission order, not end
 * (issue #972). `index` is `-1` only when nothing survives after the key — the
 * one case where ending the session is right — or when the plan itself has
 * been reordered under the run (a phase sits at the key's position but belongs
 * to a different lift), where every position is suspect and ending is the safe
 * answer.
 *
 * The queue is emitted in key order, so the first phase comparing greater is
 * the nearest survivor; no sort is needed. Phases are compared field by field
 * rather than through {@link phaseKey}, so a scan allocates nothing.
 */
export function reanchorIndex(
  queue: readonly TimerPhase[],
  key: TimerPhaseKey,
): { index: number; exact: boolean } {
  const positional = queue.findIndex((phase) => comparePosition(phase, key) === 0);
  if (positional !== -1) {
    const hit = queue[positional];
    if (hit && hit.lift === key.lift) return { index: positional, exact: true };
    return { index: -1, exact: false };
  }
  const next = queue.findIndex((phase) => comparePosition(phase, key) > 0);
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
    isKind(value.kind) &&
    typeof value.lift === 'string'
  );
}
