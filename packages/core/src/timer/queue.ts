import { resolveDuration } from './settings';
import type { TimerLiftPlan, TimerPhase, TimerSettings, TimerSetPlan } from './types';

/** A flattened `(lift, set)` pair, in performance order. */
export interface TimerQueueSet {
  lift: string;
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
      out.push({ lift: lift.lift, tm: lift.tm, set });
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

  sets.forEach(({ lift, tm, set }, setIndex) => {
    const common = { lift, tm, set, setIndex, next: null };

    const prep = resolveDuration(settings, lift, 'prep');
    if (prep > 0) {
      queue.push({ ...common, kind: 'prep', label: 'Get set', dur: prep });
    }

    queue.push({
      ...common,
      kind: 'set',
      label: setLabelFor(set),
      dur: resolveDuration(settings, lift, set.type === 'warmup' ? 'warmupSet' : 'workSet'),
    });

    queue.push({
      ...common,
      kind: 'rest',
      label: 'Rest',
      dur: resolveDuration(settings, lift, set.type === 'warmup' ? 'restWarmup' : 'restWork'),
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

  let current = 0;
  for (let i = 0; i <= idx && i < queue.length; i++) {
    if (queue[i]?.kind === 'set') current++;
  }
  // A prep phase precedes its set, so report the set it is preparing for rather
  // than the one just finished — otherwise the header reads "Set 0 of 9".
  return { current: Math.max(1, current), total };
}
