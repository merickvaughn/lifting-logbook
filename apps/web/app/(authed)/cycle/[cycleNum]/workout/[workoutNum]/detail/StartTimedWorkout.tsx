'use client';

import Link from 'next/link';
import { useTimerRowState } from '@/components/timer/WorkoutTimerProvider';
import styles from './detail.module.css';

interface Props {
  cycleNum: number;
  workoutNum: number;
}

/**
 * The "start a timed session" affordance on the workout-detail page.
 *
 * Renders nothing when there is nothing to time (no training max, so no planned
 * sets) rather than offering a button that would start an empty queue.
 */
export default function StartTimedWorkout({ cycleNum, workoutNum }: Props) {
  const timer = useTimerRowState();
  if (!timer || timer.planSummary === null) return null;

  return (
    <>
      <button type="button" className={`${styles.btnPrimary} focus-ring`} onClick={timer.startSession}>
        ▶ {timer.running ? 'Restart timed workout' : 'Start timed workout'}
      </button>
      <p className={styles.timerHint}>
        <span>Timed plan: {timer.planSummary}</span>
        <Link href={`/cycle/${cycleNum}/workout/${workoutNum}/timer`}>Timer settings</Link>
      </p>
    </>
  );
}
