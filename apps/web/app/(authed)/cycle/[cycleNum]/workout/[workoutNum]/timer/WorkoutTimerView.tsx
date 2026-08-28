'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatDuration, queueSummary } from '@lifting-logbook/core';
import type { TimerLiftPlan } from '@lifting-logbook/core';
import TimerDial from '@/components/timer/TimerDial';
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
  const timeLabel = running ? `${overrun ? '+' : ''}${formatDuration(remaining)}` : formatDuration(firstPhase?.dur ?? 0);

  const subLabel =
    phase == null ? (queue.length > 0 ? 'Tap start to begin' : 'Nothing scheduled')
    : phase.kind === 'rest' ?
      (phase.next ? `Up next: ${phase.next.lift} · ${phase.next.setLabel}` : 'Last set done')
    : `${phase.set.setLabel} · ${phase.set.spec}`;

  // Last 3 seconds before a set ends: the number grows and takes the accent color,
  // matching the audible countdown.
  const counting =
    settings.behavior.countdown3 &&
    running &&
    phase?.kind !== 'rest' &&
    remaining > 0 &&
    remaining <= 3;

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
            {!running ? 'Start'
            : phase?.kind === 'rest' ?
              overrun ? 'Start next set'
              : 'Skip rest'
            : 'Skip'}
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
            Reset session
          </button>
        </div>

        <h2 className={styles.sectionTitle}>Session queue</h2>
        {queue.length === 0 ?
          <p className={styles.emptyQueue}>
            No timed sets — set a training max to see planned weights.
          </p>
        : <ol className={styles.queue}>
            {queue.map((item, i) => {
              const state =
                !running ? ''
                : i < (timer.run?.idx ?? 0) ? styles.queueRowDone
                : i === timer.run?.idx ? styles.queueRowCurrent
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
        <TimerSettingsPanel
          settings={settings}
          onChange={timer.updateSettings}
          lifts={lifts}
        />
      </section>
    </main>
  );
}
