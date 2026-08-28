'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTimerQueue,
  defaultTimerSettings,
  phaseDuration,
  phaseProgress,
  phaseRemaining,
  setProgress,
} from '@lifting-logbook/core';
import type {
  TimerLiftPlan,
  TimerPhase,
  TimerRunState,
  TimerSettings,
  TimerWorkoutKey,
} from '@lifting-logbook/core';
import { beep, buzz, releaseWakeLock, requestWakeLock } from './timerAlerts';
import {
  loadTimerRun,
  loadTimerSettings,
  saveTimerRun,
  saveTimerSettings,
} from './timerSettings';

/**
 * How often the display re-renders.
 *
 * This is a *render* cadence, not a timekeeping one — every value below is
 * recomputed from `Date.now()`, so a throttled or stopped interval costs
 * smoothness and nothing else. See `elapsedSeconds` in @lifting-logbook/core.
 */
const TICK_MS = 200;

/** Frequencies and durations tuned so rest and set endings are distinguishable. */
const ALERT_SET_END = { hz: 940, ms: 400 } as const;
const ALERT_REST_END = { hz: 520, ms: 260 } as const;
const ALERT_COUNTDOWN = { hz: 760, ms: 90 } as const;
const ALERT_START = { hz: 880, ms: 60 } as const;

export interface WorkoutTimerView {
  /** The built queue. Rebuilt whenever settings or the plan change. */
  queue: TimerPhase[];
  /** The active phase, or `null` when no session is running. */
  phase: TimerPhase | null;
  run: TimerRunState | null;
  running: boolean;
  paused: boolean;
  /** Seconds left; negative once the phase has run over. */
  remaining: number;
  /** Effective phase length in seconds, including any rest nudge. */
  duration: number;
  /** Dial fill, 0–1. */
  progress: number;
  /** True once `remaining` has gone negative. */
  overrun: boolean;
  /** 1-based set ordinal and total, for "Set 3 of 9". */
  setOrdinal: { current: number; total: number };
  /** Fraction of the queue completed, 0–1, for the thin progress bar. */
  sessionProgress: number;
}

export interface WorkoutTimerControls {
  /** Starts (or restarts) the session at a queue index. */
  startAt: (index: number) => void;
  /** Starts at the first phase of the given set. */
  startAtSet: (setIndex: number) => void;
  /** Advances to the next phase, ending the session past the last one. */
  next: () => void;
  /** Steps back one phase. No-op at the start. */
  previous: () => void;
  togglePause: () => void;
  /** Adds or removes seconds from the current rest phase. */
  nudge: (seconds: number) => void;
  /** Ends the session and clears the persisted run. */
  end: () => void;
}

export interface UseWorkoutTimerResult extends WorkoutTimerView, WorkoutTimerControls {
  settings: TimerSettings;
  /** Replaces settings and persists them. The queue rebuilds on the next render. */
  updateSettings: (next: TimerSettings) => void;
  /** False until the persisted blob has been read — avoids an SSR/client mismatch. */
  hydrated: boolean;
  /** Phase-transition copy for the polite live region. Empty before the first phase. */
  announcement: string;
}

/**
 * Drives a timed workout session.
 *
 * Owns the tick loop, the alerts, the wake lock, and persistence; the pure queue
 * and clock math live in @lifting-logbook/core. Mounting this hook on two routes
 * (the timer page and the detail-page dock) is what makes a run continue across a
 * navigation — both read the same persisted run.
 */
export function useWorkoutTimer(
  lifts: readonly TimerLiftPlan[],
  /** Must be referentially stable — memoize it on the route params. */
  workout: TimerWorkoutKey,
): UseWorkoutTimerResult {
  // Seeded with the defaults, NOT with persisted settings: a `useState`
  // initializer runs during the first client render, so reading storage here
  // would render a different plan estimate than the server just sent and trip a
  // hydration mismatch. The mount effect below swaps in the persisted values.
  const [settings, setSettings] = useState<TimerSettings>(defaultTimerSettings);
  const [run, setRun] = useState<TimerRunState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  // Drives re-render only; every displayed value is derived from Date.now() below.
  const [, setTick] = useState(0);

  // Read persisted state after mount, never during render: the server has no
  // localStorage, so seeding from it in the initial state would hydrate a dial
  // that disagrees with the server-rendered markup.
  //
  // `workout` is required to be referentially stable (callers memoize it on the
  // route params), so this settles once per workout rather than re-reading
  // storage on every render.
  useEffect(() => {
    setSettings(loadTimerSettings());
    setRun(loadTimerRun(workout));
    setHydrated(true);
  }, [workout]);

  const queue = useMemo(() => buildTimerQueue(lifts, settings), [lifts, settings]);

  // A queue that shrank under a running session (e.g. skipWarmups was switched on
  // mid-workout) would leave idx dangling past the end; treat that as finished.
  const phase = run && run.idx < queue.length ? (queue[run.idx] ?? null) : null;

  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Last whole second an alert fired for, so a 200ms tick beeps once per second
  // rather than five times. -1 means "nothing yet this phase".
  const alertedAtRef = useRef(-1);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  const commitRun = useCallback((next: TimerRunState | null) => {
    setRun(next);
    saveTimerRun(next);
  }, []);

  const updateSettings = useCallback((next: TimerSettings) => {
    setSettings(next);
    saveTimerSettings(next);
  }, []);

  // ---------------------------------------------------------------------------
  // Wake lock
  // ---------------------------------------------------------------------------

  const releaseLock = useCallback(() => {
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    void releaseWakeLock(sentinel);
  }, []);

  const acquireLock = useCallback(async () => {
    if (wakeLockRef.current) return;
    wakeLockRef.current = await requestWakeLock();
  }, []);

  const wantsLock = run !== null && settings.behavior.awake;

  useEffect(() => {
    if (!wantsLock) {
      releaseLock();
      return;
    }
    void acquireLock();

    // Per the Screen Wake Lock spec the browser drops the lock whenever the
    // document hides and does NOT restore it on return, so re-acquire on every
    // visibility change for as long as the session is running.
    function onVisibility() {
      if (document.visibilityState === 'visible') void acquireLock();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      releaseLock();
    };
  }, [wantsLock, acquireLock, releaseLock]);

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  const startAt = useCallback(
    (index: number) => {
      if (index < 0 || index >= queue.length) {
        commitRun(null);
        return;
      }
      alertedAtRef.current = -1;
      commitRun({
        idx: index,
        startedAt: Date.now(),
        pausedMs: 0,
        pausedAt: null,
        bonus: 0,
        workout,
      });
    },
    [queue.length, commitRun, workout],
  );

  const startAtSet = useCallback(
    (setIndex: number) => {
      const index = queue.findIndex((p) => p.setIndex === setIndex);
      startAt(index < 0 ? 0 : index);
    },
    [queue, startAt],
  );

  const next = useCallback(() => {
    startAt(run ? run.idx + 1 : 0);
  }, [run, startAt]);

  const previous = useCallback(() => {
    if (run && run.idx > 0) startAt(run.idx - 1);
  }, [run, startAt]);

  const togglePause = useCallback(() => {
    if (!run) return;
    if (run.pausedAt !== null) {
      // Fold the completed pause into the running total so elapsed stays a pure
      // wall-clock subtraction rather than needing a list of pause intervals.
      commitRun({ ...run, pausedMs: run.pausedMs + (Date.now() - run.pausedAt), pausedAt: null });
    } else {
      commitRun({ ...run, pausedAt: Date.now() });
    }
  }, [run, commitRun]);

  const nudge = useCallback(
    (seconds: number) => {
      if (!run) return;
      commitRun({ ...run, bonus: run.bonus + seconds });
    },
    [run, commitRun],
  );

  const end = useCallback(() => {
    commitRun(null);
    setAnnouncement('');
  }, [commitRun]);

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  // Held in a ref so the interval effect depends only on whether a session is
  // active — re-creating the interval on every state change would reset it 5×/s.
  const advanceRef = useRef<() => void>(() => {});

  useEffect(() => {
    advanceRef.current = () => {
      if (!run || run.pausedAt !== null || !phase) return;

      const behavior = settingsRef.current.behavior;
      const left = phaseRemaining(phase, run, Date.now());

      if (left > 0) {
        // 3-2-1 before a set only: rest ending is not time-critical the way
        // getting under the bar on time is.
        if (behavior.countdown3 && phase.kind !== 'rest' && left <= 3) {
          const second = Math.ceil(left);
          if (second !== alertedAtRef.current) {
            alertedAtRef.current = second;
            beep(behavior.alert, ALERT_COUNTDOWN.hz, ALERT_COUNTDOWN.ms);
          }
        }
        return;
      }

      // Phase end: fire once, then either advance or let rest count up.
      if (alertedAtRef.current !== 0) {
        alertedAtRef.current = 0;
        const isRest = phase.kind === 'rest';
        const tone = isRest ? ALERT_REST_END : ALERT_SET_END;
        beep(behavior.alert, tone.hz, tone.ms);
        buzz(behavior.alert, isRest ? [120, 80, 120] : 200);
      }

      if (phase.kind !== 'rest' || !behavior.countUp) next();
    };
  }, [run, phase, next]);

  const active = run !== null && run.pausedAt === null;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      advanceRef.current();
      setTick((n) => n + 1);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  // Returning to a backgrounded tab: recompute immediately rather than waiting up
  // to a full tick, and let the advance logic catch up on phases that ended while
  // the interval was throttled.
  useEffect(() => {
    if (!active) return;
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        advanceRef.current();
        setTick((n) => n + 1);
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [active]);

  // Announce phase transitions only. The ticking number is a role="timer", which
  // is a live region with an implicit aria-live="off" — announcing every 200ms
  // update would make the page unusable with a screen reader.
  useEffect(() => {
    if (!phase) return;
    setAnnouncement(`${phase.label}, ${phase.lift}`);
  }, [phase]);

  // Release the lock if the component unmounts mid-session (e.g. route change).
  useEffect(() => releaseLock, [releaseLock]);

  // ---------------------------------------------------------------------------
  // Derived view
  // ---------------------------------------------------------------------------

  const now = Date.now();
  const remaining = phase && run ? phaseRemaining(phase, run, now) : 0;
  const duration = phase && run ? phaseDuration(phase, run) : 0;
  const progress = phase && run ? phaseProgress(phase, run, now) : 0;
  const setOrdinal = setProgress(queue, run?.idx ?? -1);

  return {
    queue,
    phase,
    run,
    running: run !== null,
    paused: run?.pausedAt != null,
    remaining,
    duration,
    progress,
    overrun: remaining < 0,
    setOrdinal,
    sessionProgress: queue.length > 0 && run ? run.idx / queue.length : 0,
    settings,
    updateSettings,
    hydrated,
    announcement,
    startAt,
    startAtSet,
    next,
    previous,
    togglePause,
    nudge,
    end,
  };
}

/** The gesture beep that unlocks the AudioContext. Call from the Start handler. */
export function playStartChime(settings: TimerSettings): void {
  beep(settings.behavior.alert, ALERT_START.hz, ALERT_START.ms);
}
