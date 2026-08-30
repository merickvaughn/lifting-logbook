import {
  applyClassifications,
  buildTimerQueue,
  defaultTimerSettings,
  flattenSets,
  queueSummary,
  setProgress,
  snapshotClassifications,
} from '@src/core';
import type { TimerLiftPlan, TimerPhase, TimerSettings } from '@src/core';

/**
 * A stored classification (what `snapshotClassifications`/`applyClassifications`
 * traffic in), spelled without importing `LiftClassification` directly — it is
 * not re-exported from `@src/core` (only ever `import type`-ed within the
 * package, never re-exported), so every consumer here derives it from
 * `TimerLiftPlan['classification']` instead.
 */
type StoredClassification = Exclude<TimerLiftPlan['classification'], undefined> | null;

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

describe('buildTimerQueue — accessory durations', () => {
  /**
   * One compound lift and one accessory lift.
   *
   * Two working sets each, deliberately: `buildTimerQueue` drops the *trailing*
   * rest, so a one-set-per-lift plan would leave the final lift with no rest
   * phase to assert on at all.
   */
  function mixedPlan(): TimerLiftPlan[] {
    return [
      {
        lift: 'Bench Press',
        classification: 'compound',
        sets: [
          { type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' },
          { type: 'work', setLabel: 'Set 2', spec: '3 × 230 lbs' },
        ],
      },
      {
        lift: 'Cable Curls',
        classification: 'accessory',
        sets: [
          { type: 'work', setLabel: 'Set 1', spec: '10 × 40 lbs' },
          { type: 'work', setLabel: 'Set 2', spec: '10 × 40 lbs' },
        ],
      },
    ];
  }

  function restAfter(queue: readonly TimerPhase[], lift: string): number {
    const rest = queue.find((phase) => phase.kind === 'rest' && phase.lift === lift);
    if (!rest) throw new Error(`no rest phase found for ${lift}`);
    return rest.dur;
  }

  it('shortens the accessory lift and leaves the compound one alone, in one queue', () => {
    // Both lifts, one queue, one settings object. Asserting on an
    // accessory-only plan would pass equally well against a rung that fires for
    // every lift; asserting on a compound-only plan would pass against a rung
    // that never fires at all. The contrast is what has to hold.
    const queue = buildTimerQueue(mixedPlan(), settings());

    expect(restAfter(queue, 'Cable Curls')).toBe(90);
    expect(restAfter(queue, 'Bench Press')).toBe(240);

    const curlSet = queue.find((p) => p.kind === 'set' && p.lift === 'Cable Curls');
    const benchSet = queue.find((p) => p.kind === 'set' && p.lift === 'Bench Press');
    expect(curlSet?.dur).toBe(45);
    expect(benchSet?.dur).toBe(60);
  });

  it('reverts both lifts to the preset when the accessory toggle is off', () => {
    const s = defaultTimerSettings();
    s.context.accessoryOn = false;

    const queue = buildTimerQueue(mixedPlan(), s);

    expect(restAfter(queue, 'Cable Curls')).toBe(240);
    expect(restAfter(queue, 'Bench Press')).toBe(240);
  });

  it('carries the classification through flattenSets', () => {
    // The flatten is where the lift object stops being available. If it drops
    // `classification`, buildTimerQueue silently resolves every lift as
    // unclassified — a failure with no type error and no visible symptom beyond
    // durations that look plausible.
    // One entry per set, so two per lift.
    const flat = flattenSets(mixedPlan(), false);

    expect(flat.map((entry) => entry.classification)).toEqual([
      'compound',
      'compound',
      'accessory',
      'accessory',
    ]);
  });

  it('leaves an unclassified lift on the preset', () => {
    const queue = buildTimerQueue(
      [
        {
          lift: 'Zercher Good Morning',
          sets: [
            { type: 'work', setLabel: 'Set 1', spec: '8 × 95 lbs' },
            { type: 'work', setLabel: 'Set 2', spec: '8 × 95 lbs' },
          ],
        },
      ],
      settings(),
    );

    expect(restAfter(queue, 'Zercher Good Morning')).toBe(240);
  });
});

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

  // The original implementation counted `set` phases in 0..idx. A prep precedes
  // the set it belongs to, so that reported the PREVIOUS set's ordinal at every
  // prep but the first — where a `Math.max(1, …)` floor happened to produce the
  // right answer, which is the only index the two tests above cover. Assert
  // every prep, so the general contract is actually exercised.
  it('reports the upcoming set at EVERY prep phase, not just the first', () => {
    const queue = buildTimerQueue(plan(), settings());
    const preps = queue.reduce<number[]>(
      (acc, p, i) => (p.kind === 'prep' ? [...acc, i] : acc),
      [],
    );
    expect(preps.length).toBeGreaterThan(1);

    for (const idx of preps) {
      const expected = at(queue, idx).setIndex + 1;
      expect(setProgress(queue, idx)).toEqual({ current: expected, total: 4 });
    }
  });

  it('reports the set just completed during its rest phase', () => {
    const queue = buildTimerQueue(plan(), settings());
    const rests = queue.reduce<number[]>(
      (acc, p, i) => (p.kind === 'rest' ? [...acc, i] : acc),
      [],
    );

    for (const idx of rests) {
      const expected = at(queue, idx).setIndex + 1;
      expect(setProgress(queue, idx).current).toBe(expected);
    }
  });

  it('does not report a set past the end when the queue is empty', () => {
    expect(setProgress([], -1)).toEqual({ current: 0, total: 0 });
  });
});

// Issue #966: the timer page and the workout-detail dock each resolve a custom
// lift's classification independently, so a fetch failure or a mid-session
// reclassification on one route — and not the other — could change the same
// in-flight rest's duration depending on which surface you looked at. These two
// functions are the fix: `snapshotClassifications` pins the answer once when a
// run starts, and `applyClassifications` reapplies it on every later rebuild.
describe('snapshotClassifications', () => {
  it('keys each lift by name, storing null (not undefined) for one with no opinion', () => {
    // `null`, never `undefined`: `undefined`-valued keys don't survive the
    // `JSON.stringify` a snapshot is persisted through, so `undefined` here
    // would make a "no opinion" pin indistinguishable from "never pinned" the
    // moment a different route reads it back — see the field doc on
    // `TimerRunState.classifications`.
    const snapshot = snapshotClassifications(mixedPlanWithUnclassified());
    expect(snapshot).toEqual({
      'Bench Press': 'compound',
      'Cable Curls': 'accessory',
      'Zercher Good Morning': null,
    });
  });

  it('returns an empty map for an empty plan', () => {
    expect(snapshotClassifications([])).toEqual({});
  });

  // Same hazard `settings.test.ts` covers for `overrides`/`presets`: a lift name
  // is arbitrary user input (a custom lift's own name). A plain `{}`
  // accumulator would silently drop this entry instead of storing it — the
  // `__proto__` setter no-ops for a non-object value rather than throwing — so
  // the assertion that actually catches a regression here is that the entry
  // comes back at all, as an own property.
  it('stores a lift literally named __proto__ as its own entry', () => {
    const lifts: TimerLiftPlan[] = [
      { lift: '__proto__', classification: 'accessory', sets: [] },
    ];

    const snapshot = snapshotClassifications(lifts);

    expect(Object.prototype.hasOwnProperty.call(snapshot, '__proto__')).toBe(true);
    expect(snapshot['__proto__']).toBe('accessory');
  });
});

describe('applyClassifications', () => {
  it('overrides a pinned lift and leaves an unpinned one as this call resolved it', () => {
    const overridden = applyClassifications(mixedPlanWithUnclassified(), {
      'Cable Curls': null, // pinned by a route whose fetch failed: no opinion
    });

    expect(overridden.find((l) => l.lift === 'Cable Curls')?.classification).toBeUndefined();
    // Bench Press has no entry in the map at all — keeps its own resolution.
    expect(overridden.find((l) => l.lift === 'Bench Press')?.classification).toBe('compound');
  });

  it('is a no-op for an empty classifications map', () => {
    const lifts = mixedPlanWithUnclassified();
    expect(applyClassifications(lifts, {})).toEqual(lifts);
  });

  it('produces a queue whose durations match the route that pinned them, not the route reapplying them', () => {
    // The load-bearing case: two lifts, identical shape, that would resolve
    // Cable Curls differently — one classifies it an accessory, the other has
    // no opinion (a degraded fetch). Applying the first route's pinned snapshot
    // to the second route's lifts must produce the first route's durations.
    const pinnedElsewhere = snapshotClassifications(mixedPlanWithUnclassified());
    const thisRoutesOwnResolution: TimerLiftPlan[] = mixedPlanWithUnclassified().map((l) =>
      l.lift === 'Cable Curls' ? { ...l, classification: undefined } : l,
    );

    const reconciled = applyClassifications(thisRoutesOwnResolution, pinnedElsewhere);
    const queue = buildTimerQueue(reconciled, settings());
    const curlRest = queue.find((p) => p.kind === 'rest' && p.lift === 'Cable Curls');

    expect(curlRest?.dur).toBe(90); // the accessory rest, not the 240s preset
  });

  it('forces a pinned "no opinion" onto a lift the reapplying call resolved differently', () => {
    // The mirror image of the test above, and the case that motivated storing
    // `null` instead of `undefined`: the PINNING route's own fetch degraded (no
    // opinion for Cable Curls), and the REAPPLYING route's own fetch succeeded
    // (resolves it an accessory). The pin must still win — the first route to
    // start a run is not privileged just because it started first, and neither
    // route's own resolution should ever get the last word once a pin exists.
    const pinnedNoOpinion = snapshotClassifications(
      mixedPlanWithUnclassified().map((l) =>
        l.lift === 'Cable Curls' ? { ...l, classification: undefined } : l,
      ),
    );
    const reapplyingRoutesOwnResolution = mixedPlanWithUnclassified(); // Cable Curls: 'accessory'

    const reconciled = applyClassifications(reapplyingRoutesOwnResolution, pinnedNoOpinion);
    const queue = buildTimerQueue(reconciled, settings());
    const curlRest = queue.find((p) => p.kind === 'rest' && p.lift === 'Cable Curls');

    expect(curlRest?.dur).toBe(240); // the preset, not the 90s accessory rest
  });

  it('reads a lift literally named __proto__ as its own entry, not the inherited member', () => {
    const lifts: TimerLiftPlan[] = [{ lift: '__proto__', sets: [] }];

    // Built via JSON.parse, not an object literal — `{ __proto__: … }` in a
    // literal sets the prototype instead of creating an own key, so a literal
    // could not reproduce what a persisted (and re-normalized) run actually
    // carries.
    const classifications = JSON.parse('{"__proto__":"accessory"}') as Record<
      string,
      StoredClassification
    >;

    const overridden = applyClassifications(lifts, classifications);
    expect(overridden[0]?.classification).toBe('accessory');
  });
});

/**
 * Two sets per lift, deliberately, same reason as `mixedPlan()` above:
 * `buildTimerQueue` drops the trailing rest, so one set would leave the last
 * lift with no rest phase to assert on.
 */
function mixedPlanWithUnclassified(): TimerLiftPlan[] {
  return [
    {
      lift: 'Bench Press',
      classification: 'compound',
      sets: [
        { type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' },
        { type: 'work', setLabel: 'Set 2', spec: '3 × 230 lbs' },
      ],
    },
    {
      lift: 'Cable Curls',
      classification: 'accessory',
      sets: [
        { type: 'work', setLabel: 'Set 1', spec: '10 × 40 lbs' },
        { type: 'work', setLabel: 'Set 2', spec: '10 × 40 lbs' },
      ],
    },
    {
      lift: 'Zercher Good Morning',
      sets: [
        { type: 'work', setLabel: 'Set 1', spec: '8 × 95 lbs' },
        { type: 'work', setLabel: 'Set 2', spec: '8 × 95 lbs' },
      ],
    },
  ];
}
