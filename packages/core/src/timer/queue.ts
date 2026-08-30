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
