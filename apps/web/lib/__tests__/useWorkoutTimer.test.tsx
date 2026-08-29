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
