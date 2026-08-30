import { act, renderHook } from '@testing-library/react';
import type { TimerLiftPlan, TimerWorkoutKey } from '@lifting-logbook/core';
import { useWorkoutTimer } from '../useWorkoutTimer';
import { TIMER_STORAGE_KEY, loadTimerRun, loadTimerSettings, saveTimerSettings } from '../timerSettings';

// The alert wrappers reach for AudioContext / navigator.vibrate / wakeLock, none of
// which jsdom implements. Mocked at the module boundary so the tests assert on the
// timer's decisions rather than on Web Audio plumbing.
// Browser-shaped sentinels. The browser flips `released` when the document
// hides and leaves the object in place, so a mock resolving `null` leaves the
// hook's ref permanently empty and never exercises its liveness guard — which
// is exactly how "the wake lock is never re-acquired after the first hide"
// shipped with two green tests over it.
const mockSentinels: { released: boolean }[] = [];

jest.mock('../timerAlerts', () => ({
  beep: jest.fn(),
  buzz: jest.fn(),
  requestWakeLock: jest.fn(async () => {
    const sentinel = { released: false, release: jest.fn(async () => undefined) };
    mockSentinels.push(sentinel);
    return sentinel;
  }),
  releaseWakeLock: jest.fn(async (sentinel: { released: boolean } | null) => {
    if (sentinel) sentinel.released = true;
  }),
}));

import { beep, buzz, requestWakeLock } from '../timerAlerts';

/** Drives `document.visibilityState` and fires the matching event. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const WORKOUT: TimerWorkoutKey = { program: '531', cycleNum: 1, workoutNum: 1 };

const LIFTS: TimerLiftPlan[] = [
  {
    lift: 'Bench Press',
    tm: 'TM: 285 lbs',
    sets: [
      { type: 'warmup', setLabel: 'Warm-up 1', spec: '5 × 135 lbs' },
      { type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' },
    ],
  },
];

/**
 * Advances the wall clock *and* fires the interval, the way real time does.
 *
 * Modern fake timers move `Date.now()` as part of `advanceTimersByTime`, so this
 * must not also call `setSystemTime` — that would advance the clock twice.
 * `setSystemTime` on its own is used below to model the opposite case: a clock
 * that moves while the interval is throttled.
 */
function advance(ms: number) {
  jest.advanceTimersByTime(ms);
}

function render() {
  return renderHook(() => useWorkoutTimer(LIFTS, WORKOUT));
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-28T10:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('queue and startup', () => {
  it('builds prep -> set -> rest per set, with the trailing rest dropped', () => {
    const { result } = render();
    expect(result.current.queue.map((p) => p.kind)).toEqual([
      'prep',
      'set',
      'rest',
      'prep',
      'set',
    ]);
  });

  it('is idle until started', () => {
    const { result } = render();
    expect(result.current.running).toBe(false);
    expect(result.current.phase).toBeNull();
  });

  it('starts at a chosen set rather than always at the top', () => {
    const { result } = render();
    act(() => result.current.startAtSet(1));
    expect(result.current.phase?.set.setLabel).toBe('Set 1');
  });
});

describe('wall-clock timekeeping', () => {
  it('counts down from the clock even when the interval never fires', () => {
    const { result, rerender } = render();
    act(() => result.current.startAt(1)); // the 60s working... (warm-up set, 30s)

    const duration = result.current.duration;

    // Move the clock WITHOUT running timers: this is a throttled background tab,
    // or a locked phone. The countdown must still be correct on return.
    act(() => {
      jest.setSystemTime(Date.now() + 10_000);
    });
    rerender();

    expect(result.current.remaining).toBeCloseTo(duration - 10, 1);
  });

  it('freezes while paused and resumes without losing the paused span', () => {
    const { result, rerender } = render();
    act(() => result.current.startAt(1));
    const duration = result.current.duration;

    advance(5_000);
    act(() => result.current.togglePause());

    // 60s pass while paused; the countdown must not move.
    act(() => {
      jest.setSystemTime(Date.now() + 60_000);
    });
    rerender();
    expect(result.current.remaining).toBeCloseTo(duration - 5, 1);

    act(() => result.current.togglePause());
    act(() => {
      jest.setSystemTime(Date.now() + 5_000);
    });
    rerender();
    expect(result.current.remaining).toBeCloseTo(duration - 10, 1);
  });

  it('reports overrun as negative remaining rather than clamping', () => {
    const settings = loadTimerSettings();
    settings.behavior.countUp = true;
    saveTimerSettings(settings);

    const { result, rerender } = render();
    // Index 2 is the rest phase, which counts up past zero.
    act(() => result.current.startAt(2));
    const duration = result.current.duration;

    act(() => {
      jest.setSystemTime(Date.now() + (duration + 7) * 1000);
    });
    rerender();

    expect(result.current.overrun).toBe(true);
    expect(result.current.remaining).toBeCloseTo(-7, 1);
    expect(result.current.progress).toBe(1);
  });
});

describe('advancing', () => {
  it('auto-advances when a set phase ends', () => {
    const { result } = render();
    act(() => result.current.startAt(1));
    expect(result.current.phase?.kind).toBe('set');

    act(() => advance((result.current.duration + 1) * 1000));

    expect(result.current.phase?.kind).toBe('rest');
  });

  it('holds on a rest phase past zero when countUp is on', () => {
    const { result } = render();
    act(() => result.current.startAt(2));
    expect(result.current.phase?.kind).toBe('rest');

    act(() => advance((result.current.duration + 5) * 1000));

    expect(result.current.phase?.kind).toBe('rest');
    expect(result.current.overrun).toBe(true);
  });

  it('auto-advances past rest when countUp is off', () => {
    const settings = loadTimerSettings();
    settings.behavior.countUp = false;
    saveTimerSettings(settings);

    const { result } = render();
    act(() => result.current.startAt(2));
    const duration = result.current.duration;

    act(() => advance((duration + 1) * 1000));

    expect(result.current.phase?.kind).not.toBe('rest');
  });

  it('ends the session past the last phase', () => {
    const { result } = render();
    act(() => result.current.startAt(result.current.queue.length - 1));
    act(() => result.current.next());

    expect(result.current.running).toBe(false);
    expect(result.current.phase).toBeNull();
  });

  it('steps back, and refuses to step before the first phase', () => {
    const { result } = render();
    act(() => result.current.startAt(2));
    act(() => result.current.previous());
    expect(result.current.run?.idx).toBe(1);

    act(() => result.current.startAt(0));
    act(() => result.current.previous());
    expect(result.current.run?.idx).toBe(0);
  });

  it('applies a nudge to rest only', () => {
    const { result } = render();
    act(() => result.current.startAt(2)); // rest
    const restDuration = result.current.duration;
    act(() => result.current.nudge(30));
    expect(result.current.duration).toBe(restDuration + 30);

    act(() => result.current.startAt(1)); // set
    const setDuration = result.current.duration;
    act(() => result.current.nudge(30));
    expect(result.current.duration).toBe(setDuration);
  });

  // `phaseDuration` floors the *result* at zero, so without clamping the bonus
  // itself it kept accumulating below the phase length: the +30s button then
  // does nothing visible until several presses have climbed back to zero.
  it('clamps the nudge so +30s is never a no-op', () => {
    const { result } = render();
    act(() => result.current.startAt(2)); // rest, 90s
    const restDuration = result.current.duration;

    for (let i = 0; i < 5; i++) act(() => result.current.nudge(-30));
    expect(result.current.duration).toBe(0);

    act(() => result.current.nudge(30));
    expect(result.current.duration).toBe(30);
    expect(restDuration).toBeGreaterThan(0);
  });

  // A hidden tab's interval is throttled or stopped. When it finally runs and
  // finds the phase over, the NEXT phase must start from the moment the previous
  // one actually ended — not from now, which would hand back a full fresh phase.
  it('carries the overrun forward when a phase ends while the interval is stopped', () => {
    const { result, rerender } = render();
    act(() => result.current.startAt(1)); // 30s warm-up set
    const setDuration = result.current.duration;
    expect(setDuration).toBe(30);

    // 100s of wall clock pass with the interval never firing.
    act(() => {
      jest.setSystemTime(Date.now() + 100_000);
    });
    // One tick: the set ended 70s ago, so its rest is already 70s in.
    advance(200);
    rerender();

    expect(result.current.phase?.kind).toBe('rest');
    const restDuration = result.current.duration;
    expect(result.current.remaining).toBeCloseTo(restDuration - 70, 0);
  });
});

describe('queue rebuilt under a live run', () => {
  it('re-anchors the run on the same set when skipWarmups renumbers the queue', () => {
    const { result } = render();
    act(() => result.current.startAtSet(1)); // the working set (starts at its prep)
    expect(result.current.phase?.set.setLabel).toBe('Set 1');
    const kindBefore = result.current.phase?.kind;
    const idxBefore = result.current.run?.idx;

    act(() => {
      const next = { ...result.current.settings };
      next.behavior = { ...next.behavior, skipWarmups: true };
      result.current.updateSettings(next);
    });

    // Same phase of the same set, at whatever index it now occupies. Anchoring
    // on `setIndex` would have failed here: dropping the warm-up renumbers the
    // timed set list, so the working set's index changes from 1 to 0.
    expect(result.current.running).toBe(true);
    expect(result.current.phase?.set.setLabel).toBe('Set 1');
    expect(result.current.phase?.kind).toBe(kindBefore);
    expect(result.current.run?.idx).not.toBe(idxBefore);
  });

  it('ends the session when the phase it was on is removed from the queue', () => {
    const { result } = render();
    act(() => result.current.startAtSet(0)); // the warm-up set
    expect(result.current.phase?.set.setLabel).toBe('Warm-up 1');

    act(() => {
      const next = { ...result.current.settings };
      next.behavior = { ...next.behavior, skipWarmups: true };
      result.current.updateSettings(next);
    });

    // The warm-up is gone. The run must be cleared, not left pointing past the
    // end with a live interval and no surface able to stop it.
    expect(result.current.running).toBe(false);
    expect(result.current.phase).toBeNull();
    expect(loadTimerRun(WORKOUT)).toBeNull();
  });
});

describe('alerts', () => {
  it('fires once when a phase ends, not once per tick', () => {
    const { result } = render();
    act(() => result.current.startAt(2)); // rest counts up, so it stays put
    jest.mocked(beep).mockClear();

    act(() => advance((result.current.duration + 3) * 1000));

    expect(jest.mocked(beep)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(buzz)).toHaveBeenCalledTimes(1);
  });

  it('ticks the last three seconds before a set, and not before rest', () => {
    const { result } = render();
    act(() => result.current.startAt(1)); // a set phase
    const duration = result.current.duration;
    jest.mocked(beep).mockClear();

    act(() => advance((duration - 3) * 1000));
    act(() => advance(1_000));
    act(() => advance(1_000));

    // 3, 2, 1 — one call per whole second, despite five ticks per second.
    expect(jest.mocked(beep).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(jest.mocked(beep).mock.calls.length).toBeLessThanOrEqual(3);

    // Rest: the countdown ticks must not fire.
    act(() => result.current.startAt(2));
    jest.mocked(beep).mockClear();
    act(() => advance((result.current.duration - 3) * 1000));
    act(() => advance(2_000));
    expect(jest.mocked(beep)).not.toHaveBeenCalled();
  });

  it('honours a Silent alert setting', () => {
    const settings = loadTimerSettings();
    settings.behavior.alert = 'Silent';
    saveTimerSettings(settings);

    const { result } = render();
    act(() => result.current.startAt(2));
    act(() => advance((result.current.duration + 2) * 1000));

    // The hook still calls through; the wrapper is what honours the mode. Assert it
    // was told the mode, so the decision is provably reaching the alert layer.
    for (const call of jest.mocked(beep).mock.calls) expect(call[0]).toBe('Silent');
    for (const call of jest.mocked(buzz).mock.calls) expect(call[0]).toBe('Silent');
  });
});

describe('wake lock', () => {
  it('requests a lock while running and not before', () => {
    const { result } = render();
    expect(jest.mocked(requestWakeLock)).not.toHaveBeenCalled();

    act(() => result.current.startAt(0));
    expect(jest.mocked(requestWakeLock)).toHaveBeenCalled();
  });

  it('does not request a lock when the setting is off', () => {
    const settings = loadTimerSettings();
    settings.behavior.awake = false;
    saveTimerSettings(settings);

    const { result } = render();
    act(() => result.current.startAt(0));

    expect(jest.mocked(requestWakeLock)).not.toHaveBeenCalled();
  });

  // Per Screen Wake Lock §3.3 the browser releases the lock when the document
  // hides and does NOT restore it, leaving a sentinel whose `released` is true.
  // A presence-only guard sees that dead sentinel and never re-acquires, so the
  // lock silently stops working after the first tab switch — the exact bug the
  // visibility handling was written to avoid.
  it('re-acquires the lock after the document hides and returns', async () => {
    const { result } = render();
    await act(async () => {
      result.current.startAt(0);
    });
    const afterStart = jest.mocked(requestWakeLock).mock.calls.length;
    expect(afterStart).toBe(1);

    await act(async () => {
      const held = mockSentinels[mockSentinels.length - 1];
      if (held) held.released = true; // the browser releases it on hide
      setVisibility('hidden');
    });
    await act(async () => setVisibility('visible'));

    expect(jest.mocked(requestWakeLock).mock.calls.length).toBe(afterStart + 1);
  });

  it('does not re-acquire while the held lock is still live', async () => {
    const { result } = render();
    await act(async () => {
      result.current.startAt(0);
    });

    // Visible -> visible with nothing released: the guard must hold.
    await act(async () => setVisibility('visible'));
    await act(async () => setVisibility('visible'));

    expect(jest.mocked(requestWakeLock).mock.calls.length).toBe(1);
  });

  it('does not acquire twice when two requests interleave before either resolves', async () => {
    const { result } = render();
    await act(async () => {
      result.current.startAt(0);
    });
    jest.mocked(requestWakeLock).mockClear();

    await act(async () => {
      const held = mockSentinels[mockSentinels.length - 1];
      if (held) held.released = true;
      // Two visibility events in the same frame, before the first await settles.
      setVisibility('visible');
      setVisibility('visible');
    });

    expect(jest.mocked(requestWakeLock).mock.calls.length).toBe(1);
  });
});

describe('persistence', () => {
  it('persists the run so another surface can pick it up', () => {
    const { result } = render();
    act(() => result.current.startAt(1));

    expect(loadTimerRun(WORKOUT)?.idx).toBe(1);
  });

  it('clears the persisted run when the session ends', () => {
    const { result } = render();
    act(() => result.current.startAt(1));
    act(() => result.current.end());

    expect(loadTimerRun(WORKOUT)).toBeNull();
  });

  it('restores a run belonging to this workout on mount', () => {
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({
        settings: null,
        run: {
          idx: 3,
          startedAt: Date.now(),
          pausedMs: 0,
          pausedAt: null,
          bonus: 0,
          workout: WORKOUT,
        },
      }),
    );

    const { result } = render();
    expect(result.current.run?.idx).toBe(3);
    expect(result.current.running).toBe(true);
  });

  it('ignores a run belonging to a different workout', () => {
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({
        settings: null,
        run: {
          idx: 3,
          startedAt: Date.now(),
          pausedMs: 0,
          pausedAt: null,
          bonus: 0,
          workout: { ...WORKOUT, workoutNum: 99 },
        },
      }),
    );

    const { result } = render();
    expect(result.current.running).toBe(false);
  });

  it('renders defaults on the first pass, before reading storage', () => {
    // Regression: a useState initializer that read localStorage would produce a
    // different plan on the client's first render than the server just sent,
    // tripping a React hydration mismatch (caught by the timer e2e spec, where
    // the server said "40:00 estimated" and the client said "46:00"). Persisted
    // settings must arrive via the mount effect instead.
    const stored = loadTimerSettings();
    stored.preset = 'Heavy day';
    saveTimerSettings(stored);

    let firstRenderPreset: string | null = null;
    renderHook(() => {
      const timer = useWorkoutTimer(LIFTS, WORKOUT);
      firstRenderPreset ??= timer.settings.preset;
      return timer;
    });

    expect(firstRenderPreset).toBe('Standard');
  });

  it('applies persisted settings once hydrated', () => {
    const stored = loadTimerSettings();
    stored.preset = 'Heavy day';
    saveTimerSettings(stored);

    const { result } = render();

    expect(result.current.hydrated).toBe(true);
    expect(result.current.settings.preset).toBe('Heavy day');
  });

  it('rebuilds the queue when settings change', () => {
    const { result } = render();
    expect(result.current.queue.some((p) => p.set.type === 'warmup')).toBe(true);

    act(() => {
      const next = loadTimerSettings();
      next.behavior.skipWarmups = true;
      result.current.updateSettings(next);
    });

    expect(result.current.queue.some((p) => p.set.type === 'warmup')).toBe(false);
  });
});

// Issue #966: the timer page and the workout-detail dock each resolve a custom
// lift's classification independently — their own `fetchCustomLifts()` call,
// bounded and caught so neither a failure nor a slow response can hold up a
// timer. If that fetch fails (or is slow) on one route and not the other, the
// two mounts of this hook — sharing the same persisted run via `ll.timer.v1` —
// could disagree about the same in-flight rest's duration. `TimerRunState`
// pins the classification a run started with so a later mount reapplies it
// rather than resolving it fresh; these tests mount the hook twice, exactly as
// the two routes do, to prove the two can no longer disagree.
describe('classification pinning across two mounts (issue #966)', () => {
  const CUSTOM_LIFT_SETS = [
    { type: 'work' as const, setLabel: 'Set 1', spec: '10 × 40 lbs' },
    { type: 'work' as const, setLabel: 'Set 2', spec: '10 × 40 lbs' },
  ];

  /** One custom lift, classified however this "route" resolved it. */
  function liftsClassifiedAs(classification: 'accessory' | undefined): TimerLiftPlan[] {
    return [{ lift: 'Cable Curls', classification, sets: CUSTOM_LIFT_SETS }];
  }

  // Queue for a single two-set lift, default settings: prep, set, rest, prep,
  // set — the trailing rest dropped. Index 2 is the rest after the first set.
  const REST_INDEX = 2;

  it('keeps a pinned rest duration even when the other mount resolves classification differently', () => {
    // This mount's own fetchCustomLifts() succeeded: Cable Curls is an accessory.
    const mountA = renderHook(() => useWorkoutTimer(liftsClassifiedAs('accessory'), WORKOUT));
    act(() => mountA.result.current.startAt(REST_INDEX));
    expect(mountA.result.current.duration).toBe(90); // the accessory rest, not 240

    // A fresh mount for the same workout — the other route, whose own fetch
    // degraded to "no opinion" for this lift. It restores the persisted run on
    // mount, the same way navigating to the other page would.
    const mountB = renderHook(() => useWorkoutTimer(liftsClassifiedAs(undefined), WORKOUT));

    expect(mountB.result.current.running).toBe(true);
    expect(mountB.result.current.phase?.lift).toBe('Cable Curls');
    // The load-bearing assertion: mount B's own resolution says "no opinion",
    // which would resolve to the 240s preset. It must report mount A's pinned
    // 90s instead — the whole point of the fix.
    expect(mountB.result.current.duration).toBe(90);
  });

  // The mirror image of the primary case above — the one that motivated
  // storing a pinned "no opinion" as `null` rather than `undefined` (see the
  // field doc on `TimerRunState.classifications`). `undefined` doesn't survive
  // the JSON round trip through localStorage, so an earlier version of this fix
  // let a second mount's own (successful) resolution silently override an
  // absent pin — reopening the exact disagreement this test proves closed: the
  // pin decides, not whichever mount happens to read it, and not whichever
  // mount's fetch happened to succeed.
  it('keeps a pinned "no opinion" even when the other mount would have resolved it', () => {
    const mountA = renderHook(() => useWorkoutTimer(liftsClassifiedAs(undefined), WORKOUT));
    act(() => mountA.result.current.startAt(REST_INDEX));
    expect(mountA.result.current.duration).toBe(240); // no opinion -> the preset

    // A fresh mount whose own fetch succeeded: Cable Curls resolves 'accessory'.
    const mountB = renderHook(() => useWorkoutTimer(liftsClassifiedAs('accessory'), WORKOUT));
    // The load-bearing assertion: mount B's own resolution would give 90s, but
    // the pin says "no opinion" — it must report mount A's pinned 240s instead.
    expect(mountB.result.current.duration).toBe(240);
  });

  // The bonus case the issue calls out: even on a single mount, with no second
  // route involved, a live run's classification must not drift if the *same*
  // page later resolves the lift differently — a settings refresh, or the user
  // reclassifying it mid-session while a rest is already counting down.
  it('does not re-resolve classification when the lifts prop changes under a live run', () => {
    const { result, rerender } = renderHook(
      ({ classification }: { classification: 'accessory' | undefined }) =>
        useWorkoutTimer(liftsClassifiedAs(classification), WORKOUT),
      { initialProps: { classification: 'accessory' } },
    );
    act(() => result.current.startAt(REST_INDEX));
    expect(result.current.duration).toBe(90);

    rerender({ classification: undefined });

    // Still the pinned 90s, not whatever `lifts` resolves to now.
    expect(result.current.duration).toBe(90);
  });

  // Review finding on issue #966's own PR: `startAt` must key its pin
  // carry-forward on `run.classifications` specifically, not `run` as a whole.
  // `WorkoutTimerProvider`'s `rowState` context depends on `startAt` (and
  // `startAtSet`, which depends on `startAt`) precisely because it was stable
  // across everything except a phase boundary — see that file's own docblock —
  // and `nudge`/`togglePause` both spread `run` into a new object on every
  // press, so keying on the whole object would silently reopen the per-tick
  // re-render `rowState` exists to avoid.
  it('keeps startAt and startAtSet stable across a nudge and a pause', () => {
    // Built once, outside the render callback: `liftsClassifiedAs` returns a
    // fresh array each call, and passing it inline would make `lifts` itself
    // churn every render — confounding the one thing this test isolates
    // (`run` vs `run.classifications` in `startAt`'s own dependency array)
    // with an unrelated instability in the test's own fixture.
    const lifts = liftsClassifiedAs('accessory');
    const { result } = renderHook(() => useWorkoutTimer(lifts, WORKOUT));
    act(() => result.current.startAt(REST_INDEX));

    const startAtBefore = result.current.startAt;
    const startAtSetBefore = result.current.startAtSet;

    act(() => result.current.nudge(30));
    act(() => result.current.togglePause());

    expect(result.current.startAt).toBe(startAtBefore);
    expect(result.current.startAtSet).toBe(startAtSetBefore);
  });

  // Review finding on issue #966's own PR: the queue is built from
  // `effectiveLifts`, but `effectiveLifts` itself wasn't exposed — so a
  // consumer resolving a per-lift classification for *display* (the timer
  // page's Settings tab, which reads `lift.classification` to render "Rest
  // follows …") had no pinned view to read and fell back to the route's raw
  // `lifts` prop, which can disagree with the queue/dial during a live run.
  it('exposes effectiveLifts with the pinned classification applied, for consumers other than the queue', () => {
    const mountA = renderHook(() => useWorkoutTimer(liftsClassifiedAs('accessory'), WORKOUT));
    act(() => mountA.result.current.startAt(REST_INDEX));

    // The other route's own resolution says "no opinion" — but its
    // `effectiveLifts`, not just its `queue`, must reflect the pin.
    const mountB = renderHook(() => useWorkoutTimer(liftsClassifiedAs(undefined), WORKOUT));
    expect(mountB.result.current.effectiveLifts[0]?.classification).toBe('accessory');
  });
});
