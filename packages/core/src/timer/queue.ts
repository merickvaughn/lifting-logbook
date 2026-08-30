import type { LiftClassification } from '@lifting-logbook/types';
import { resolveDuration } from './settings';
import type { TimerLiftPlan, TimerPhase, TimerSettings, TimerSetPlan } from './types';

/** A flattened `(lift, set)` pair, in performance order. */
export interface TimerQueueSet {
  lift: string;
  /**
   * Carried down from the {@link TimerLiftPlan} this set came from.
   *
   * The flatten is where the lift object stops being available, so a role
   * dropped here is a role `buildTimerQueue` can no longer resolve durations
   * with — every accessory would silently fall through to the preset.
   */
  classification?: LiftClassification | undefined;
  tm?: string | undefined;
  set: TimerSetPlan;
}

/**
 * Flattens the plan to the ordered set list the queue is built from — and the
 * same list the detail page indexes to mark rows active or done.
 *
 * Warm-ups are dropped here rather than inside {@link buildTimerQueue} so that
 * `setIndex` always addresses the *timed* set list, keeping the two in step when
 * `skipWarmups` is on.
 */
export function flattenSets(
  lifts: readonly TimerLiftPlan[],
  skipWarmups: boolean,
): TimerQueueSet[] {
  const out: TimerQueueSet[] = [];
  for (const lift of lifts) {
    for (const set of lift.sets) {
      if (skipWarmups && set.type === 'warmup') continue;
      out.push({ lift: lift.lift, classification: lift.classification, tm: lift.tm, set });
    }
  }
  return out;
}

function setLabelFor(set: TimerSetPlan): string {
  return set.type === 'warmup' ? 'Warm-up set' : 'Working set';
}

/**
 * Expands a workout plan into the ordered phase queue.
 *
 * Each set contributes up to three phases — an optional `prep` countdown, the
 * `set` itself, then `rest`. The trailing rest is dropped so a session ends on
 * a set rather than leaving the lifter counting down after the last rep; a
 * `prep` of zero is omitted rather than emitted as an instant phase.
 */
export function buildTimerQueue(
  lifts: readonly TimerLiftPlan[],
  settings: TimerSettings,
): TimerPhase[] {
  const sets = flattenSets(lifts, settings.behavior.skipWarmups);
  const queue: TimerPhase[] = [];

  sets.forEach(({ lift, classification, tm, set }, setIndex) => {
    const common = { lift, tm, set, setIndex, next: null };

    const prep = resolveDuration(settings, lift, 'prep', classification);
    if (prep > 0) {
      queue.push({ ...common, kind: 'prep', label: 'Get set', dur: prep });
    }

    queue.push({
      ...common,
      kind: 'set',
      label: setLabelFor(set),
      dur: resolveDuration(
        settings,
        lift,
        set.type === 'warmup' ? 'warmupSet' : 'workSet',
        classification,
      ),
    });

    queue.push({
      ...common,
      kind: 'rest',
      label: 'Rest',
      dur: resolveDuration(
        settings,
        lift,
        set.type === 'warmup' ? 'restWarmup' : 'restWork',
        classification,
      ),
    });
  });

  while (queue[queue.length - 1]?.kind === 'rest') queue.pop();

  // Annotate each phase with the next *set* after it, so a rest phase can say
  // what it is resting before. Walked backwards so this stays O(n).
  let upcoming: TimerPhase['next'] = null;
  for (let i = queue.length - 1; i >= 0; i--) {
    const phase = queue[i];
    if (!phase) continue;
    phase.next = upcoming;
    if (phase.kind === 'set') {
      upcoming = { lift: phase.lift, setLabel: phase.set.setLabel, spec: phase.set.spec };
    }
  }

  return queue;
}

/**
 * Snapshots each lift's resolved classification, keyed by lift name.
 *
 * What a fresh run pins into {@link TimerRunState.classifications} so a later
 * queue rebuild — on either route, at any point in the run's lifetime — can
 * reapply the same answer via {@link applyClassifications} instead of
 * re-resolving it and risking a different result. See the field doc on
 * `TimerRunState.classifications` for why that risk is real.
 *
 * Built on `Object.create(null)` rather than `{}`: a lift name is arbitrary
 * user input (a custom lift's own name), and a literal `"__proto__"` or
 * `"toString"` must land as its own entry rather than being read through, or
 * silently reassigning, `Object.prototype` — the same hazard `hasOwn`/`defineOwn`
 * guard against in `./settings`, sidestepped here at the root by giving the
 * accumulator no prototype to collide with.
 */
export function snapshotClassifications(
  lifts: readonly TimerLiftPlan[],
): Record<string, LiftClassification | undefined> {
  const out: Record<string, LiftClassification | undefined> = Object.create(null);
  for (const lift of lifts) out[lift.lift] = lift.classification;
  return out;
}

/**
 * Overrides each lift's classification with the pinned value from a run's
 * snapshot, where one names that lift.
 *
 * A lift the snapshot has no entry for — one new to the plan since the run
 * started, or a `classifications` map normalized from a run persisted before
 * this field existed — keeps whatever classification this call already
 * resolved for it, exactly as every route did before this existed. Pinning is
 * additive, never a reason for a lift to lose an opinion it already has.
 *
 * Reads via a borrowed `hasOwnProperty`, not the `in` operator: both
 * {@link snapshotClassifications} and `normalizeClassifications` (`./settings`)
 * hand this a null-prototype map, so `in` would be equally safe against either
 * — but this function's own safety should not depend on every future caller
 * remembering that. `in` walks the prototype chain, so on an ordinary `{}`-based
 * map a lift literally named `"toString"` — absent from the map — would read as
 * present, sourcing its classification from `Object.prototype.toString`.
 */
export function applyClassifications(
  lifts: readonly TimerLiftPlan[],
  classifications: Record<string, LiftClassification | undefined>,
): TimerLiftPlan[] {
  return lifts.map((lift) =>
    Object.prototype.hasOwnProperty.call(classifications, lift.lift) ?
      { ...lift, classification: classifications[lift.lift] }
    : lift,
  );
}

/** Headline numbers for the "Timed plan: N sets · M:SS including rest" hint. */
export interface TimerQueueSummary {
  sets: number;
  totalSeconds: number;
}

export function queueSummary(queue: readonly TimerPhase[]): TimerQueueSummary {
  let sets = 0;
  let totalSeconds = 0;
  for (const phase of queue) {
    if (phase.kind === 'set') sets++;
    totalSeconds += phase.dur;
  }
  return { sets, totalSeconds };
}

/** 1-based ordinal of the set the given queue index belongs to, and the total. */
export function setProgress(
  queue: readonly TimerPhase[],
  idx: number,
): { current: number; total: number } {
  let total = 0;
  for (const phase of queue) if (phase.kind === 'set') total++;

  // Read the ordinal off the phase itself. Every phase carries the flat index of
  // the set it belongs to — a prep counts down to that set, a rest follows it —
  // so this is correct for all three kinds.
  //
  // Counting `set` phases in `0..idx` instead reports the *previous* set during
  // every prep but the first, because a prep precedes the set it belongs to and
  // so is not yet counted. A `Math.max(1, …)` floor hid that at index 0, which
  // was the only index covered by a test.
  const phase = idx >= 0 && idx < queue.length ? queue[idx] : undefined;
  const current = phase ? phase.setIndex + 1 : Math.min(1, total);

  return { current, total };
}
