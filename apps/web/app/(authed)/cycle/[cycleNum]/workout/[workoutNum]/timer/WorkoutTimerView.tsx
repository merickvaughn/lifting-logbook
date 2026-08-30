'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatDuration, queueSummary } from '@lifting-logbook/core';
import type { TimerLiftPlan } from '@lifting-logbook/core';
import TimerDial from '@/components/timer/TimerDial';
import {
  END_SESSION_LABEL,
  phaseSubLabel,
  primaryActionLabel,
  signedTime,
} from '@/lib/timerLabels';
import { playStartChime, useWorkoutTimer } from '@/lib/useWorkoutTimer';
import TimerSettingsPanel from './TimerSettingsPanel';
import styles from './timer.module.css';

interface Props {
  lifts: TimerLiftPlan[];
  program: string;
  cycleNum: number;
  workoutNum: number;
  week: number;
}

type Tab = 'live' | 'settings';

export default function WorkoutTimerView({ lifts, program, cycleNum, workoutNum, week }: Props) {
  const [tab, setTab] = useState<Tab>('live');

  // Stable identity so the hook's mount effect does not re-run every render.
  const workout = useMemo(
    () => ({ program, cycleNum, workoutNum }),
    [program, cycleNum, workoutNum],
  );

  const timer = useWorkoutTimer(lifts, workout);
  const {
    queue,
    phase,
    running,
    paused,
    remaining,
    progress,
    overrun,
    setOrdinal,
    sessionProgress,
    settings,
  } = timer;

  const summary = useMemo(() => queueSummary(queue), [queue]);
  const detailHref = `/cycle/${cycleNum}/workout/${workoutNum}/detail`;

  const firstPhase = queue[0] ?? null;
  // Derived in @/lib/timerLabels so this and the detail-page dock cannot drift.
  const timeLabel =
    running ? signedTime(remaining, overrun) : formatDuration(firstPhase?.dur ?? 0);

  const subLabel =
    phase == null ? (queue.length > 0 ? 'Tap start to begin' : 'Nothing scheduled')
    : phaseSubLabel(phase);

  // Last 3 seconds before a set ends: the number grows and takes the accent color,
  // matching the audible countdown.
  const counting =
    settings.behavior.countdown3 &&
    running &&
    phase?.kind !== 'rest' &&
    remaining > 0 &&
    remaining <= 3;

  // The 200ms tick re-renders this whole component, so building 40-60 list items
  // inline would reconstruct and diff them five times a second for a list whose
  // only change is which single row is marked current.
  const activeIdx = timer.run?.idx ?? -1;
  const queueList = useMemo(
    () => (
      <ol className={styles.queue}>
        {queue.map((item, i) => {
          const state =
            !running ? ''
            : i < activeIdx ? styles.queueRowDone
            : i === activeIdx ? styles.queueRowCurrent
            : '';
          return (
            <li key={`${item.kind}-${i}`} className={`${styles.queueRow} ${state}`}>
              <span className={styles.queueLabel}>
                <span className={styles.queueKind}>
                  {item.kind === 'prep' ? 'Setup' : item.kind === 'rest' ? 'Rest' : 'Set'}
                </span>
                <span>
                  {item.lift}
                  {item.kind === 'set' ? ` · ${item.set.spec}` : ''}
                </span>
              </span>
              <span className={styles.queueDur}>{formatDuration(item.dur)}</span>
            </li>
          );
        })}
      </ol>
    ),
    [queue, running, activeIdx],
  );

  const settingsPanel = useMemo(
    () => (
      <TimerSettingsPanel settings={settings} onChange={timer.updateSettings} lifts={lifts} />
    ),
    [settings, timer.updateSettings, lifts],
  );

  function handlePrimary() {
    if (!running) playStartChime(settings);
    timer.next();
  }

  return (
    <main className={styles.container}>
      <div className={styles.topBar}>
        <Link href={detailHref} className={styles.backLink}>
          ‹ Week {week} · Workout {workoutNum}
        </Link>
        <div className={styles.tabs} role="tablist" aria-label="Timer views">
          <button
            type="button"
            role="tab"
            id="timer-tab-live"
            aria-selected={tab === 'live'}
            aria-controls="timer-panel-live"
            className={`${styles.tab} ${tab === 'live' ? styles.tabActive : ''} focus-ring`}
            onClick={() => setTab('live')}
          >
            Timer
          </button>
          <button
            type="button"
            role="tab"
            id="timer-tab-settings"
            aria-selected={tab === 'settings'}
            aria-controls="timer-panel-settings"
            className={`${styles.tab} ${tab === 'settings' ? styles.tabActive : ''} focus-ring`}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </div>
      </div>

      {/*
        Phase transitions only. The countdown itself is a role="timer" below,
        which is a live region with an implicit aria-live="off" — announcing
        every 200ms tick would make the page unusable with a screen reader.
      */}
      <p aria-live="polite" className={styles.srOnly}>
        {timer.announcement}
      </p>

      <section
        role="tabpanel"
        id="timer-panel-live"
        aria-labelledby="timer-tab-live"
        hidden={tab !== 'live'}
      >
        <div className={styles.sessionHead}>
          <h1 className={styles.sessionName}>
            Week {week} · Workout {workoutNum}
          </h1>
          <p className={styles.sessionMeta}>
            {running ?
              `Set ${setOrdinal.current} of ${setOrdinal.total}${phase ? ` · ${phase.lift}` : ''}`
            : queue.length > 0 ?
              `${summary.sets} timed sets · ${formatDuration(summary.totalSeconds)} estimated`
            : 'Not started'}
          </p>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${Math.round(sessionProgress * 100)}%` }}
            />
          </div>
        </div>

        <TimerDial
          size={260}
          stroke={10}
          progress={running ? progress : 0}
          kind={phase?.kind ?? null}
          overrun={overrun}
        >
          <span className={styles.phaseLabel}>
            {!running ? 'Ready' : `${paused ? 'Paused · ' : ''}${phase?.label ?? ''}`}
          </span>
          <span
            role="timer"
            className={`${styles.dialTime} ${counting ? styles.dialTimeCounting : ''}`}
          >
            {timeLabel}
          </span>
          <span className={styles.dialSub}>{subLabel}</span>
        </TimerDial>

        <div className={styles.liftLine}>
          <p className={styles.liftLineName}>{phase?.lift ?? firstPhase?.lift ?? '—'}</p>
          <p className={styles.liftLineSpec}>{phase?.tm ?? firstPhase?.tm ?? ''}</p>
        </div>

        <div className={styles.controls}>
          <button
            type="button"
            className={`${styles.btnSecondary} focus-ring`}
            onClick={timer.togglePause}
            disabled={!running}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className={`${styles.btnPrimary} focus-ring`}
            onClick={handlePrimary}
            disabled={queue.length === 0}
          >
            {primaryActionLabel(running, phase, overrun)}
          </button>
        </div>

        <div className={styles.microRow}>
          <button
            type="button"
            className={`${styles.microBtn} focus-ring`}
            onClick={() => timer.nudge(30)}
            disabled={!running}
          >
            +30s
          </button>
          <button
            type="button"
            className={`${styles.microBtn} focus-ring`}
            onClick={() => timer.nudge(-30)}
            disabled={!running}
          >
            −30s
          </button>
          <button
            type="button"
            className={`${styles.microBtn} focus-ring`}
            onClick={timer.previous}
            disabled={!running}
          >
            Previous
          </button>
          <button
            type="button"
            className={`${styles.microBtn} focus-ring`}
            onClick={timer.end}
            disabled={!running}
          >
            {END_SESSION_LABEL}
          </button>
        </div>

        <h2 className={styles.sectionTitle}>Session queue</h2>
        {queue.length === 0 ?
          <p className={styles.emptyQueue}>
            No timed sets — set a training max to see planned weights.
          </p>
        : queueList
        }

        <p className={styles.persistNote}>
          Timers run on the clock, not the screen — lock your phone mid-rest and it keeps counting.
        </p>
      </section>

      <section
        role="tabpanel"
        id="timer-panel-settings"
        aria-labelledby="timer-tab-settings"
        hidden={tab !== 'settings'}
      >
        {/*
          Mounted only while its tab is active, AND memoized. The two guards do
          different jobs: `tab === 'settings'` controls mounting, but a mounted
          panel still reconciles on every 200ms tick — ~40 steppers plus a row per
          lift — because this component re-renders five times a second during a
          run, and the wake lock means the browser never throttles it. Same
          technique and same reason as `queueList` above. All three props are
          referentially stable across ticks (`settings` is state, `updateSettings`
          is a []-dep useCallback, `lifts` is a page prop), so the memo actually
          holds rather than recomputing anyway.
        */}
        {tab === 'settings' && settingsPanel}
      </section>
    </main>
  );
}
