'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyClassifications,
  buildTimerQueue,
  defaultTimerSettings,
  phaseDuration,
  phaseKey,
  phaseProgress,
  phaseRemaining,
  reanchorIndex,
  setProgress,
  snapshotClassifications,
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
  /**
   * `lifts`, with a live run's pinned classification applied — see
   * `TimerRunState.classifications` in @lifting-logbook/core. The queue below is
   * built from this, not from `lifts`; any other UI that resolves a per-lift
   * duration or label from `.classification` must read it from here too, or it
   * can disagree with the queue/dial about the same lift during a live run
   * (issue #966). Referentially stable across ticks — see the comment where
   * this is computed.
   */
  effectiveLifts: readonly TimerLiftPlan[];
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

  // A live run pins its lifts' classification (see `TimerRunState.classifications`
  // in @lifting-logbook/core) so that once a run exists, every queue rebuild — on
  // this route or the other — reapplies that pinned answer rather than whatever
  // this mount resolved on its own. Without it, the timer page and the
  // workout-detail dock could independently resolve a custom lift's
  // classification differently (a `fetchCustomLifts()` failure on one route and
  // not the other, or a mid-session reclassification) and disagree about the
  // same in-flight rest's duration — issue #966.
  //
  // Keyed on `run?.classifications` rather than `run` itself: that reference is
  // stable across a pause, nudge, or phase advance (see `commitRun` and `startAt`
  // below, both of which carry the existing map forward rather than rebuilding
  // it), and changes only when a run is freshly hydrated or freshly started — so
  // this does not rebuild the queue on every tick-driven state change.
  const runClassifications = run?.classifications;
  const effectiveLifts = useMemo(
    () => (runClassifications ? applyClassifications(lifts, runClassifications) : lifts),
    [lifts, runClassifications],
  );

  const queue = useMemo(
    () => buildTimerQueue(effectiveLifts, settings),
    [effectiveLifts, settings],
  );

  // Where the run's anchor sits in the queue as currently built. Memoized on the
  // anchor itself — not on `run`, which gets a new identity on every pause and
  // nudge — so it is recomputed only when the queue or the anchored phase
  // changes. The displayed phase is read through it rather than through
  // `run.idx`: `idx` is a cache the effect below brings up to date one render
  // later, and reading it here would let a rebuild paint, announce, and tick
  // against a phase the run is not on for that one render.
  const anchor = run?.on;
  const anchored = useMemo(
    () => (anchor ? reanchorIndex(queue, anchor) : null),
    [queue, anchor],
  );
  const phase = anchored?.exact ? (queue[anchored.index] ?? null) : null;
  const activeIndex = anchored?.exact ? anchored.index : -1;

  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const acquiringRef = useRef<Promise<void> | null>(null);
  // Last whole second an alert fired for, so a 200ms tick beeps once per second
  // rather than five times. -1 means "nothing yet this phase".
  const alertedAtRef = useRef(-1);
  // Written in an effect, not during render: a render-phase ref mutation is not
  // idempotent, which breaks the moment a Suspense boundary above this component
  // replays a render.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

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

  // Guard on *liveness*, not presence. Per Screen Wake Lock §3.3 the browser
  // releases the lock when the document hides, but it leaves the sentinel object
  // in place with `released` true — so a plain `if (wakeLockRef.current) return`
  // sees a dead sentinel and never re-acquires. That is precisely the "silently
  // stops working after the first tab switch" failure this visibility handling
  // exists to prevent, and it is invisible to a test whose `requestWakeLock`
  // mock resolves `null`, because the ref then never holds anything at all.
  //
  // `acquiringRef` shares the in-flight request so two calls that interleave
  // before either resolves cannot both acquire, orphaning a sentinel that
  // nothing is left holding a reference to release.
  const acquireLock = useCallback(async () => {
    const held = wakeLockRef.current;
    if (held && !held.released) return;
    if (acquiringRef.current) return acquiringRef.current;

    const pending = requestWakeLock().then((sentinel) => {
      const current = wakeLockRef.current;
      if (current && !current.released) {
        // Another call won the race while this one awaited.
        void releaseWakeLock(sentinel);
        return;
      }
      wakeLockRef.current = sentinel;
    });

    acquiringRef.current = pending;
    try {
      await pending;
    } finally {
      if (acquiringRef.current === pending) acquiringRef.current = null;
    }
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
    /**
     * `startedAt` defaults to now, but the auto-advance passes the instant the
     * previous phase actually ended so a phase boundary crossed while the tab
     * was hidden does not silently grant a full fresh phase on return.
     */
    (index: number, startedAt?: number, opts?: { paused?: boolean }) => {
      const target = queue[index];
      if (!target) {
        commitRun(null);
        return;
      }
      alertedAtRef.current = -1;
      const from = startedAt ?? Date.now();
      commitRun({
        idx: index,
        // The shape-stable identity of the phase — what every later queue
        // rebuild re-derives `idx` from (see the re-anchor effect below).
        on: phaseKey(target),
        startedAt: from,
        pausedMs: 0,
        // A re-anchor onto a surviving phase keeps a paused run paused — the
        // lifter's explicit pause outranks the fresh start (see the effect below).
        pausedAt: opts?.paused ? from : null,
        bonus: 0,
        workout,
        // Pinned once, the first time a session starts (`run` is still null),
        // then carried forward unchanged by every later call this same run makes
        // through here — advancing, jumping to a different set, resuming after a
        // backgrounded tab. Re-snapshotting on every call would defeat the pin:
        // a jump-to-set after the *other* route's fetch resolves differently
        // would silently re-diverge the two surfaces mid-run.
        //
        // Reads `runClassifications`, not `run`: `run` gets a new reference on
        // every `nudge`/`togglePause` (both spread it via `commitRun`), so
        // depending on `run` here would give `startAt` — and everything
        // downstream of it, including `WorkoutTimerProvider`'s per-tick-stable
        // `rowState` context — a new identity on every ±30s or pause press. See
        // `runClassifications` above: it carries the same reference forward
        // across those calls, so keying on it keeps `startAt` stable exactly as
        // it was before this field existed.
        classifications: runClassifications ?? snapshotClassifications(lifts),
      });
    },
    // `queue` rather than `queue.length`: the key is read off the phase itself.
    // Identity still changes only when settings or the plan change, so the
    // stability `WorkoutTimerProvider`'s per-tick-safe context relies on holds.
    [queue, commitRun, workout, runClassifications, lifts],
  );

  const startAtSet = useCallback(
    (setIndex: number) => {
      // Skip the activation: it shares the `setIndex` of the lift's first timed
      // set (as a prep does), so a plain match would land the per-set ▶ —
      // labelled "Start timer at <lift> <set>" — on a hip-airplane countdown
      // instead of on that set. Starting the whole session still reaches it,
      // because that calls `startAt(0)`, the head of the queue.
      const index = queue.findIndex((p) => p.setIndex === setIndex && p.kind !== 'activation');
      startAt(index < 0 ? 0 : index);
    },
    [queue, startAt],
  );

  // Re-anchor a live run whenever the queue is (re)built underneath it.
  //
  // The queue is derived from `settings` and the plan, and the Settings tab sits
  // on the same page as the running dial — so a mid-session change is one click
  // away. Toggling `skipWarmups`, or moving `prep` or `activation` across zero,
  // shifts every index; and a fresh mount builds the queue from *default*
  // settings on its first render and from the persisted ones on the next, so a
  // bare index recorded under one shape lands on the wrong phase under the
  // other. In every case the run's persisted anchor (`run.on`, a shape-stable
  // key — see `TimerPhaseKey`) is re-resolved against the queue as it now is:
  //
  // - same phase, maybe at a new index → keep the clock, re-point `idx`;
  // - phase gone (its duration went to 0:00, its warm-up was skipped away) →
  //   advance to the nearest surviving phase after it, as a fresh start that
  //   stays paused if the run was paused, rather than ending the session
  //   (issue #972);
  // - nothing survives after it, or the plan was reordered under the run → the
  //   session is over.
  //
  // `anchored` is the memo above, so this costs nothing on the pause/nudge
  // renders that change `run` but not the anchor, and it converges in one pass:
  // `startAt` writes the surviving phase's own key, which the next pass finds
  // exactly at the index it just committed.
  //
  // Comparing against the *previous render's* queue, as this once did, could
  // not see the mount-time case above and mis-anchored every restored run whose
  // persisted settings changed the queue's shape (issue #980).
  useEffect(() => {
    if (!run || !anchored) return;
    if (anchored.index === -1) {
      commitRun(null);
    } else if (anchored.exact) {
      if (anchored.index !== run.idx) commitRun({ ...run, idx: anchored.index });
    } else {
      startAt(anchored.index, undefined, { paused: run.pausedAt !== null });
    }
  }, [anchored, run, commitRun, startAt]);

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
      // Clamp the bonus itself, not just its effect. `phaseDuration` floors the
      // *result* at zero, so an unbounded negative bonus accumulates invisibly:
      // after ten −30s presses on a 4:00 rest, the next two +30s presses change
      // nothing on screen and the button reads as dead.
      const floor = phase && phase.kind === 'rest' ? -phase.dur : 0;
      const bonus = Math.max(floor, run.bonus + seconds);
      if (bonus === run.bonus) return;
      commitRun({ ...run, bonus });
    },
    [run, phase, commitRun],
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

      if (phase.kind !== 'rest' || !behavior.countUp) {
        // Start the next phase from the instant this one actually ended, not
        // from now. A hidden tab's interval is throttled to ~1/s and stopped
        // outright on mobile Safari, so `Date.now()` here would hand back a
        // full fresh phase on return: lock the phone during a 60s set, unlock
        // five minutes later, and the lifter is told to rest the full 4:00
        // having already stood there for five.
        const endedAt = run.startedAt + run.pausedMs + phaseDuration(phase, run) * 1000;
        startAt(run.idx + 1, Math.min(endedAt, Date.now()));
      }
    };
  }, [run, phase, startAt]);

  const active = run !== null && run.pausedAt === null;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      advanceRef.current();
      setTick((n) => n + 1);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  // Returning to a backgrounded tab: settle the phase that ended while hidden
  // immediately rather than waiting up to a full tick. One phase is settled per
  // call; because each new phase now starts from the previous one's true end
  // (see `startAt` above), the interval walks through any further elapsed
  // phases on its next few ticks rather than granting each a fresh clock.
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


  // ---------------------------------------------------------------------------
  // Derived view
  // ---------------------------------------------------------------------------

  const now = Date.now();
  const remaining = phase && run ? phaseRemaining(phase, run, now) : 0;
  const duration = phase && run ? phaseDuration(phase, run) : 0;
  const progress = phase && run ? phaseProgress(phase, run, now) : 0;
  const setOrdinal = setProgress(queue, activeIndex);

  return {
    effectiveLifts,
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
    sessionProgress: queue.length > 0 && activeIndex >= 0 ? activeIndex / queue.length : 0,
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
