import {
  buildTimerQueue,
  defaultTimerSettings,
  flattenSets,
  queueSummary,
  setProgress,
} from '@src/core';
import type { TimerLiftPlan, TimerSettings } from '@src/core';

function plan(): TimerLiftPlan[] {
  return [
    {
      lift: 'Bench Press',
      tm: 'TM: 285 lbs',
      sets: [
        { type: 'warmup', setLabel: 'Warm-up 1', spec: '5 × 135 lbs' },
        { type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' },
        { type: 'work', setLabel: 'Set 2', spec: '3 × 230 lbs' },
      ],
    },
    {
      lift: 'Barbell Rows',
      sets: [{ type: 'work', setLabel: 'Set 1', spec: '5 × 185 lbs' }],
    },
  ];
}

function settings(overrides: Partial<TimerSettings> = {}): TimerSettings {
  return { ...defaultTimerSettings(), ...overrides };
}

/**
 * Indexes an array, failing the test with a useful message when the element is
 * missing.
 *
 * `noUncheckedIndexedAccess` widens every `arr[i]` to `| undefined`; this narrows
 * it once, here, rather than sprinkling non-null assertions through the
 * assertions (which the suppression policy would require justifying).
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}, but length is ${items.length}`);
  }
  return item;
}

describe('buildTimerQueue', () => {
  it('expands each set to prep -> set -> rest in performance order', () => {
    const queue = buildTimerQueue(plan(), settings());

    // 4 sets x 3 phases, minus the trailing rest.
    expect(queue).toHaveLength(11);
    expect(queue.slice(0, 3).map((p) => p.kind)).toEqual(['prep', 'set', 'rest']);
    expect(at(queue, 0).lift).toBe('Bench Press');
    expect(at(queue, 1).label).toBe('Warm-up set');
    expect(at(queue, 4).label).toBe('Working set');
  });

  it('drops the trailing rest so a session ends on a set', () => {
    const queue = buildTimerQueue(plan(), settings());
    expect(at(queue, queue.length - 1).kind).toBe('set');
    expect(queue.filter((p) => p.kind === 'rest')).toHaveLength(3);
  });

  it('omits the prep phase when the prep duration is zero', () => {
    const base = defaultTimerSettings();
    base.presets[base.preset] = {
      warmupSet: 30,
      workSet: 60,
      restWarmup: 90,
      restWork: 240,
      prep: 0,
    };

    const queue = buildTimerQueue(plan(), base);

    expect(queue.some((p) => p.kind === 'prep')).toBe(false);
    expect(at(queue, 0).kind).toBe('set');
  });

  it('skips warm-ups entirely when skipWarmups is on', () => {
    const base = defaultTimerSettings();
    base.behavior.skipWarmups = true;

    const queue = buildTimerQueue(plan(), base);

    expect(queue.filter((p) => p.kind === 'set')).toHaveLength(3);
    expect(queue.some((p) => p.set.type === 'warmup')).toBe(false);
  });

  it('keeps setIndex addressing the timed set list when warm-ups are skipped', () => {
    const base = defaultTimerSettings();
    base.behavior.skipWarmups = true;

    const queue = buildTimerQueue(plan(), base);
    const timedSets = flattenSets(plan(), true);

    for (const phase of queue) {
      expect(at(timedSets, phase.setIndex).set.setLabel).toBe(phase.set.setLabel);
    }
  });

  it('annotates each phase with the next set, and null after the last one', () => {
    const queue = buildTimerQueue(plan(), settings());

    const firstRest = queue.find((p) => p.kind === 'rest');
    expect(firstRest?.next).toEqual({
      lift: 'Bench Press',
      setLabel: 'Set 1',
      spec: '5 × 200 lbs',
    });

    expect(at(queue, queue.length - 1).next).toBeNull();
  });

  it('returns an empty queue for an empty plan', () => {
    expect(buildTimerQueue([], settings())).toEqual([]);
  });

  it('returns an empty queue when every set is a skipped warm-up', () => {
    const warmupsOnly: TimerLiftPlan[] = [
      { lift: 'Bench Press', sets: [{ type: 'warmup', setLabel: 'Warm-up 1', spec: '5 × 135' }] },
    ];
    const base = defaultTimerSettings();
    base.behavior.skipWarmups = true;

    expect(buildTimerQueue(warmupsOnly, base)).toEqual([]);
  });
});

describe('queueSummary', () => {
  it('counts timed sets and total seconds including rest', () => {
    const queue = buildTimerQueue(plan(), settings());
    const summary = queueSummary(queue);

    expect(summary.sets).toBe(4);
    // 4 prep (10) + 1 warm-up set (30) + 3 work sets (60) + 1 warm-up rest (90)
    // + 2 work rests (240) = 40 + 30 + 180 + 90 + 480.
    expect(summary.totalSeconds).toBe(820);
  });

  it('is zero for an empty queue', () => {
    expect(queueSummary([])).toEqual({ sets: 0, totalSeconds: 0 });
  });
});

describe('setProgress', () => {
  it('reports the set a prep phase is preparing for, never zero', () => {
    const queue = buildTimerQueue(plan(), settings());
    expect(at(queue, 0).kind).toBe('prep');
    expect(setProgress(queue, 0)).toEqual({ current: 1, total: 4 });
  });

  it('advances as sets are passed', () => {
    const queue = buildTimerQueue(plan(), settings());
    const setIndexes = queue.reduce<number[]>(
      (acc, p, i) => (p.kind === 'set' ? [...acc, i] : acc),
      [],
    );

    expect(setProgress(queue, at(setIndexes, 1))).toEqual({ current: 2, total: 4 });
  });
});
