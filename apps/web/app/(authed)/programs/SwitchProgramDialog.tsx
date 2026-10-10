'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { getScheduleWorkoutsPerWeek } from '@lifting-logbook/core';
import type { UserWorkoutSchedule } from '@lifting-logbook/types';
import { switchProgram } from './actions';
import styles from './programs.module.css';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatSchedule(schedule: UserWorkoutSchedule): string {
  if (schedule.type === 'fixed' && schedule.days) {
    return schedule.days.map((d) => DAY_NAMES[d]).join(' / ');
  }
  if (schedule.type === 'rotating' && schedule.weeks) {
    return schedule.weeks
      .map((week, i) => `Week ${i + 1}: ${week.map((d) => DAY_NAMES[d]).join('/')}`)
      .join(' · ');
  }
  return 'Custom schedule';
}

type Props = {
  programId: string;
  programName: string;
  currentProgramId: string | null;
  workoutSchedule: UserWorkoutSchedule | null;
  onClose: () => void;
};

export default function SwitchProgramDialog({
  programId,
  programName,
  currentProgramId,
  workoutSchedule,
  onClose,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'confirm' | 'schedule-info'>('confirm');
  const [macrocycleNum, setMacrocycleNum] = useState<number | null>(null);

  function handleConfirm() {
    startTransition(async () => {
      try {
        const result = await switchProgram(programId);
        if (workoutSchedule) {
          setMacrocycleNum(result.macrocycleNum);
          setStep('schedule-info');
        } else {
          router.push(`/macrocycle/${result.macrocycleNum}`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to switch program.');
      }
    });
  }

  function handleGoToMacrocycle() {
    if (macrocycleNum !== null) {
      router.push(`/macrocycle/${macrocycleNum}`);
    }
  }

  function handleClose() {
    setStep('confirm');
    setMacrocycleNum(null);
    setError(null);
    onClose();
  }

  const currentLabel = currentProgramId ? `your current program` : 'your dashboard';
  const workoutsPerWeek =
    step === 'schedule-info' && workoutSchedule
      ? getScheduleWorkoutsPerWeek(workoutSchedule)
      : null;

  return (
    <div
      className={styles.dialogOverlay}
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => { if (e.key === 'Escape' && !isPending) handleClose(); }}
    >
      <div className={styles.dialog}>
        {step === 'schedule-info' && workoutSchedule && macrocycleNum !== null ? (
          <>
            <p className={styles.dialogTitle}>Schedule applied to {programName}</p>
            <div className={styles.scheduleInfoBody}>
              <p className={styles.scheduleInfoText}>
                Workout dates have been distributed using your schedule.
              </p>
              <div className={styles.scheduleSummary}>
                <span className={styles.scheduleDetail}>{formatSchedule(workoutSchedule)}</span>
                <span className={styles.scheduleDetail}>
                  {workoutsPerWeek} workout{workoutsPerWeek !== 1 ? 's' : ''}/week
                </span>
              </div>
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.btnSecondary} onClick={handleClose}>
                Close
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={handleGoToMacrocycle}
              >
                Go to Macrocycle
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.dialogTitle}>Switch to {programName}?</p>
            <p className={styles.dialogBody}>
              {programName} will become your active program. Your existing lift history and
              training maxes for {currentLabel} are preserved and remain accessible.
            </p>
            {error && <p className={styles.errorNote}>{error}</p>}
            <div className={styles.dialogActions}>
              <button type="button" className={styles.btnSecondary} onClick={handleClose} disabled={isPending}>
                Cancel
              </button>
              <button type="button" className={styles.btnPrimary} onClick={handleConfirm} disabled={isPending}>
                {isPending ? 'Switching…' : 'Confirm Switch'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
