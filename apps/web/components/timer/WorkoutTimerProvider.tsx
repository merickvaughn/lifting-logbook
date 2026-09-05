'use client';

import { createContext, useContext, useMemo } from 'react';
import { flattenSets, formatDuration, queueSummary } from '@lifting-logbook/core';
import type { TimerLiftPlan } from '@lifting-logbook/core';
import { playStartChime, useWorkoutTimer } from '@/lib/useWorkoutTimer';
import type { UseWorkoutTimerResult } from '@/lib/useWorkoutTimer';
import WorkoutTimerDock from './WorkoutTimerDock';

/**
 * What the workout-detail page's set rows and start button need.
 *
 * Deliberately narrower than the full timer result, and memoized on values that
 * change only at a phase boundary — the dock re-renders five times a second, and
 * putting the whole ticking result on the context would drag every set row in the
 * lift list along with it.
 */
export interface TimerRowState {
  running: boolean;
  /** Flat set index of the current phase, or `null` when no session is running. */
  activeSetIndex: number | null;
  /**
   * Position of the lift occurrence the current phase belongs to — the list
   * auto-expands it. Positional, not the name: the same lift can appear twice
   * in one workout, and only position tells the two apart (issue #971).
   */
  activeLiftIndex: number | null;
  /** Every set index at or below this one is finished. `-1` when none are. */
  doneThroughIndex: number;
  /** Starts the session at the given flat set index. */
  startAtSet: (setIndex: number) => void;
  /** Starts the session from the beginning. */
  startSession: () => void;
  /** "4 sets · 12:20 including rest", or `null` when nothing is timed. */
  planSummary: string | null;
  /**
   * Flat set index for a rendered row, or `null` when that set is not timed.
   *
   * Built with core's own `flattenSets` from the same `effectiveLifts` the queue
   * is built from, so a row's index and the queue's agree by construction —
   * which matters because the rendered list shows every set while the queue
   * may omit warm-ups.
   *
   * Keyed by the lift's *position* in the plan (which the page's own lift list
   * shares, index for index), not its name — see `activeLiftIndex`.
   */
  setIndexOf: (liftIndex: number, setLabel: string) => number | null;
}

const TimerRowStateContext = createContext<TimerRowState | null>(null);

/**
 * Separator for the `(liftIndex, setLabel)` composite key. A delimiter a set
 * label cannot contain, matching the `:`-joined key convention in
 * `workoutDraftStorage.ts`.
 */
const KEY_SEP = '::';

function setKey(liftIndex: number, setLabel: string): string {
  return [String(liftIndex), setLabel].join(KEY_SEP);
}

/**
 * Timer state for the workout-detail page.
 *
 * Returns `null` outside a provider, so `CollapsibleLiftList` renders exactly as
 * it did before this feature when it is used anywhere else — including in its own
 * tests, which construct it directly.
 */
export function useTimerRowState(): TimerRowState | null {
  return useContext(TimerRowStateContext);
}

interface Props {
  lifts: TimerLiftPlan[];
  program: string;
  cycleNum: number;
  workoutNum: number;
  children: React.ReactNode;
}

/**
 * Owns the timed session for the workout-detail page and renders the docked
 * mini-timer beneath its children.
 *
 * The timer page mounts the same hook against the same persisted run, so a
 * session started here survives navigating there and back.
 */
export default function WorkoutTimerProvider({
  lifts,
  program,
  cycleNum,
  workoutNum,
  children,
}: Props) {
  const workout = useMemo(
    () => ({ program, cycleNum, workoutNum }),
    [program, cycleNum, workoutNum],
  );

  const timer: UseWorkoutTimerResult = useWorkoutTimer(lifts, workout);
  const { effectiveLifts, phase, running, queue, settings, startAtSet, startAt } = timer;

  const summary = useMemo(() => queueSummary(queue), [queue]);

  const setIndexes = useMemo(() => {
    const map = new Map<string, number>();
    flattenSets(effectiveLifts, settings.behavior.skipWarmups).forEach((entry, index) => {
      map.set(setKey(entry.liftIndex, entry.set.setLabel), index);
    });
    return map;
  }, [effectiveLifts, settings.behavior.skipWarmups]);

  const rowState = useMemo<TimerRowState>(
    () => ({
      running,
      activeSetIndex: phase?.setIndex ?? null,
      activeLiftIndex: phase?.liftIndex ?? null,
      // A rest phase means the set it belongs to is finished, so it counts as done
      // while the rest is still counting.
      doneThroughIndex:
        phase == null ? -1
        : phase.kind === 'rest' ? phase.setIndex
        : phase.setIndex - 1,
      startAtSet: (setIndex: number) => {
        if (!running) playStartChime(settings);
        startAtSet(setIndex);
      },
      startSession: () => {
        if (!running) playStartChime(settings);
        startAt(0);
      },
      planSummary:
        summary.sets > 0 ?
          `${summary.sets} sets · ${formatDuration(summary.totalSeconds)} including rest`
        : null,
      setIndexOf: (liftIndex, setLabel) => setIndexes.get(setKey(liftIndex, setLabel)) ?? null,
    }),
    [running, phase, startAtSet, startAt, settings, summary, setIndexes],
  );

  return (
    <TimerRowStateContext.Provider value={rowState}>
      {children}
      <WorkoutTimerDock timer={timer} cycleNum={cycleNum} workoutNum={workoutNum} />
    </TimerRowStateContext.Provider>
  );
}
