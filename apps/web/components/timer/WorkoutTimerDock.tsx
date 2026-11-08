'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  END_SESSION_LABEL,
  phaseLabel,
  phaseSubLabel,
  primaryActionLabel,
  signedTime,
} from '@/lib/timerLabels';
import { useFocusTrap } from '@/lib/useFocusTrap';
import type { UseWorkoutTimerResult } from '@/lib/useWorkoutTimer';
import TimerDial from './TimerDial';
import styles from './WorkoutTimerDock.module.css';

interface Props {
  timer: UseWorkoutTimerResult;
  macrocycleNum: number;
  workoutNum: number;
}

/**
 * The docked mini-timer, and the full-screen sheet it expands into.
 *
 * Renders nothing until a session is running, so the workout-detail page is
 * unchanged for anyone not using the timer.
 */
export default function WorkoutTimerDock({ timer, macrocycleNum, workoutNum }: Props) {
  const { phase, running, paused, remaining, progress, overrun, setOrdinal } = timer;
  const [expanded, setExpanded] = useState(false);

  const sheetRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setExpanded(false), []);

  function open() {
    setExpanded(true);
  }

  // A session that ends while the sheet is open would otherwise leave a
  // full-screen panel with nothing in it.
  useEffect(() => {
    if (!running) setExpanded(false);
  }, [running]);

  useFocusTrap(sheetRef, {
    active: expanded,
    onEscape: close,
    // The opener is a dock control, and the dock unmounts when the session
    // ends, so closing the sheet by ending the session would focus a detached
    // node and drop focus to <body>. Fall back to the start button, which is on
    // the page either way.
    returnFocus: (opener) =>
      opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-timer-start]'),
  });

  if (!running || !phase) return null;

  // Derived in @/lib/timerLabels so this and the timer page cannot drift — they
  // are two views of one session, and they had already diverged on two controls.
  const time = signedTime(remaining, overrun);
  const label = phaseLabel(phase, paused);
  const sub = phaseSubLabel(phase);
  const nextLabel = primaryActionLabel(true, phase, overrun);

  return (
    <>
      <div className={styles.dock}>
        <div className={styles.dockInner}>
          <button
            type="button"
            className={`${styles.dockRing} focus-ring`}
            aria-label="Expand timer"
            aria-expanded={expanded}
            onClick={open}
          >
            <TimerDial
              size={44}
              stroke={4}
              progress={progress}
              kind={phase.kind}
              overrun={overrun}
            />
          </button>

          <button type="button" className={`${styles.dockMeta} focus-ring`} onClick={open}>
            <span className={styles.dockPhase}>{label}</span>
            <span role="timer" className={styles.dockTime}>
              {time}
            </span>
            <span className={styles.dockSub}>
              {phase.lift} — {sub}
            </span>
          </button>

          <div className={styles.dockBtns}>
            <button
              type="button"
              className={`${styles.dockBtn} focus-ring`}
              onClick={timer.togglePause}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              className={`${styles.dockBtn} ${styles.dockBtnPrimary} focus-ring`}
              onClick={timer.next}
            >
              {nextLabel}
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div
          ref={sheetRef}
          className={styles.sheet}
          role="dialog"
          aria-modal="true"
          aria-label="Workout timer"
        >
          <div className={styles.sheetInner}>
            <div className={styles.sheetTop}>
              <button type="button" className={`${styles.sheetCollapse} focus-ring`} onClick={close}>
                ⌄ Back to workout
              </button>
              <span className={styles.sheetProgress}>
                Set {setOrdinal.current} of {setOrdinal.total}
              </span>
            </div>

            <TimerDial
              size={240}
              stroke={10}
              progress={progress}
              kind={phase.kind}
              overrun={overrun}
            >
              <span className={styles.bigPhase}>{label}</span>
              <span role="timer" className={styles.bigTime}>
                {time}
              </span>
              <span className={styles.bigSub}>{sub}</span>
            </TimerDial>

            <div className={styles.sheetLift}>
              <p className={styles.sheetLiftName}>{phase.lift}</p>
              <p className={styles.sheetLiftSpec}>{phase.tm ?? phase.set.spec}</p>
            </div>

            <div className={styles.sheetControls}>
              <button
                type="button"
                className={`${styles.btnSecondary} focus-ring`}
                onClick={timer.togglePause}
              >
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                className={`${styles.btnPrimary} focus-ring`}
                onClick={timer.next}
              >
                {nextLabel}
              </button>
            </div>

            <div className={styles.sheetMicro}>
              <button
                type="button"
                className={`${styles.microBtn} focus-ring`}
                onClick={() => timer.nudge(30)}
              >
                +30s
              </button>
              <button
                type="button"
                className={`${styles.microBtn} focus-ring`}
                onClick={() => timer.nudge(-30)}
              >
                −30s
              </button>
              <button
                type="button"
                className={`${styles.microBtn} focus-ring`}
                onClick={timer.previous}
              >
                Previous
              </button>
              <button type="button" className={`${styles.microBtn} focus-ring`} onClick={timer.end}>
                {END_SESSION_LABEL}
              </button>
            </div>

            <Link
              href={`/macrocycle/${macrocycleNum}/workout/${workoutNum}/timer`}
              className={styles.sheetLink}
            >
              Full timer &amp; settings
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
