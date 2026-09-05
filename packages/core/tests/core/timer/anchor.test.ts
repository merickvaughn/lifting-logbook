import {
  buildTimerQueue,
  comparePhaseKeys,
  defaultTimerSettings,
  isTimerPhaseKey,
  phaseKey,
  reanchorIndex,
} from '@src/core';
import type { TimerLiftPlan, TimerPhase, TimerPhaseKey, TimerSettings } from '@src/core';

/**
 * Re-anchoring a run onto a rebuilt queue by shape-stable identity (#980):
 * exact match keeps the clock; a removed phase advances to the nearest
 * survivor after it (#972); nothing surviving ends the run.
 */
const PLAN: TimerLiftPlan[] = [
  {
    lift: 'Bench Press',
    activation: 'Band Pull-Apart',
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

/** `list[index]`, or a thrown error — keeps the fixtures free of non-null assertions. */
function pick<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`nothing at index ${index}`);
  return value;
}

function settingsWith(patch: {
  skipWarmups?: boolean;
  prep?: number;
  activation?: number;
}): TimerSettings {
  const base = defaultTimerSettings();
  const active = base.presets[base.preset];
  if (!active) throw new Error(`no preset named ${base.preset}`);
  const preset = { ...active };
  if (patch.prep !== undefined) preset.prep = patch.prep;
  if (patch.activation !== undefined) preset.activation = patch.activation;
  return {
    ...base,
    presets: { ...base.presets, [base.preset]: preset },
    behavior: { ...base.behavior, skipWarmups: patch.skipWarmups ?? base.behavior.skipWarmups },
  };
}

function key(liftIndex: number, setOrdinal: number, kind: TimerPhaseKey['kind']): TimerPhaseKey {
  return { liftIndex, setOrdinal, kind };
}

function at(queue: readonly TimerPhase[], index: number): TimerPhase {
  const phase = queue[index];
  if (!phase) throw new Error(`no phase at ${index}`);
  return phase;
}

describe('comparePhaseKeys', () => {
  it('orders by lift, then set, then activation < prep < set < rest', () => {
    const ordered = [
      key(0, -1, 'activation'),
      key(0, 0, 'prep'),
      key(0, 0, 'set'),
      key(0, 0, 'rest'),
      key(0, 1, 'prep'),
      key(1, -1, 'activation'),
      key(1, 0, 'set'),
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(comparePhaseKeys(pick(ordered, i - 1), pick(ordered, i))).toBeLessThan(0);
      expect(comparePhaseKeys(pick(ordered, i), pick(ordered, i - 1))).toBeGreaterThan(0);
    }
    expect(comparePhaseKeys(key(0, 0, 'set'), key(0, 0, 'set'))).toBe(0);
  });

  it('matches the order buildTimerQueue emits', () => {
    const queue = buildTimerQueue(PLAN, defaultTimerSettings());
    const keys = queue.map(phaseKey);
    expect(keys.length).toBeGreaterThan(1);
    for (let i = 1; i < keys.length; i++) {
      expect(comparePhaseKeys(pick(keys, i - 1), pick(keys, i))).toBeLessThan(0);
    }
  });
});

describe('reanchorIndex', () => {
  const full = buildTimerQueue(PLAN, defaultTimerSettings());

  it('finds an exact match at its new index', () => {
    const set2Prep = full.findIndex((p) => p.kind === 'prep' && p.set.setLabel === 'Set 2');
    const skipped = buildTimerQueue(PLAN, settingsWith({ skipWarmups: true }));
    const result = reanchorIndex(skipped, phaseKey(at(full, set2Prep)));
    expect(result.exact).toBe(true);
    expect(at(skipped, result.index).set.setLabel).toBe('Set 2');
    expect(at(skipped, result.index).kind).toBe('prep');
    // Renumbered — the warm-up's three phases are gone.
    expect(result.index).toBe(set2Prep - 3);
  });

  it('advances from a prep set to 0:00 onto that set itself', () => {
    const set2Prep = full.findIndex((p) => p.kind === 'prep' && p.set.setLabel === 'Set 2');
    const noPrep = buildTimerQueue(PLAN, settingsWith({ prep: 0 }));
    const result = reanchorIndex(noPrep, phaseKey(at(full, set2Prep)));
    expect(result.exact).toBe(false);
    expect(at(noPrep, result.index)).toMatchObject({ kind: 'set', set: { setLabel: 'Set 2' } });
  });

  it('advances from a skipped-away warm-up onto the first work set, not back onto the activation', () => {
    const warmupSet = full.findIndex((p) => p.kind === 'set' && p.set.setLabel === 'Warm-up 1');
    const skipped = buildTimerQueue(PLAN, settingsWith({ skipWarmups: true }));
    const result = reanchorIndex(skipped, phaseKey(at(full, warmupSet)));
    expect(result.exact).toBe(false);
    expect(at(skipped, result.index)).toMatchObject({ kind: 'prep', set: { setLabel: 'Set 1' } });
  });

  it('advances from an activation set to 0:00 onto the lift’s first prep', () => {
    expect(at(full, 0).kind).toBe('activation');
    const noActivation = buildTimerQueue(PLAN, settingsWith({ activation: 0 }));
    const result = reanchorIndex(noActivation, phaseKey(at(full, 0)));
    expect(result.exact).toBe(false);
    expect(result.index).toBe(0);
    expect(at(noActivation, 0)).toMatchObject({ kind: 'prep', set: { setLabel: 'Warm-up 1' } });
  });

  it('advances past a lift that vanished entirely onto the next lift’s first phase', () => {
    const warmupOnly: TimerLiftPlan[] = [
      { lift: 'Bench Press', sets: [{ type: 'warmup', setLabel: 'Warm-up 1', spec: '5 × 135 lbs' }] },
      pick(PLAN, 1),
    ];
    const before = buildTimerQueue(warmupOnly, defaultTimerSettings());
    const after = buildTimerQueue(warmupOnly, settingsWith({ skipWarmups: true }));
    const result = reanchorIndex(after, phaseKey(at(before, 1)));
    expect(result.exact).toBe(false);
    expect(at(after, result.index)).toMatchObject({ lift: 'Barbell Rows', liftIndex: 1 });
  });

  it('returns -1 only when nothing survives at or after the key', () => {
    const last = phaseKey(at(full, full.length - 1));
    const shorter = buildTimerQueue([pick(PLAN, 0)], defaultTimerSettings());
    expect(reanchorIndex(shorter, last)).toEqual({ index: -1, exact: false });
    expect(reanchorIndex([], last)).toEqual({ index: -1, exact: false });
  });

  it('keys on the lift occurrence, so a repeated lift re-anchors onto the right one', () => {
    const twice: TimerLiftPlan[] = [pick(PLAN, 1), pick(PLAN, 1)];
    const before = buildTimerQueue(twice, defaultTimerSettings());
    const secondSet = before.findIndex((p) => p.kind === 'set' && p.liftIndex === 1);
    const after = buildTimerQueue(twice, settingsWith({ prep: 0 }));
    const result = reanchorIndex(after, phaseKey(at(before, secondSet)));
    expect(result.exact).toBe(true);
    expect(at(after, result.index).liftIndex).toBe(1);
  });
});

describe('isTimerPhaseKey', () => {
  it('accepts every kind, including an activation at ordinal -1', () => {
    expect(isTimerPhaseKey(key(0, -1, 'activation'))).toBe(true);
    expect(isTimerPhaseKey(key(3, 2, 'rest'))).toBe(true);
  });

  it.each([
    ['not an object', 'set'],
    ['an array', [0, 0, 'set']],
    ['a negative lift index', key(-1, 0, 'set')],
    ['an ordinal below -1', key(0, -2, 'set')],
    ['a fractional ordinal', key(0, 0.5, 'set')],
    ['an unknown kind', { liftIndex: 0, setOrdinal: 0, kind: 'cooldown' }],
    ['a missing field', { liftIndex: 0, kind: 'set' }],
  ])('rejects %s', (_label, value) => {
    expect(isTimerPhaseKey(value)).toBe(false);
  });
});
