'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { skipWorkout, unskipWorkout } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './SkipForm.module.css';

interface Props {
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  skipped: boolean;
}

export default function SkipForm({ program, macrocycleNum, workoutNum, skipped }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSkip() {
    setLoading(true);
    setError(null);
    try {
      await skipWorkout(program, macrocycleNum, workoutNum, reason || undefined);
      setOpen(false);
      router.refresh();
    } catch (e) {
      logClientError('skipWorkout', e, { program, macrocycleNum, workoutNum });
      setError('Failed to skip workout. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleUnskip() {
    setLoading(true);
    setError(null);
    try {
      await unskipWorkout(program, macrocycleNum, workoutNum);
      setOpen(false);
      router.refresh();
    } catch (e) {
      logClientError('unskipWorkout', e, { program, macrocycleNum, workoutNum });
      setError('Failed to undo skip. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.trigger} onClick={() => setOpen(true)}>
        {skipped ? '↩ Undo Skip' : '⊘ Mark as Skipped'}
      </button>
    );
  }

  return (
    <div className={styles.form}>
      {skipped ? (
        <p className={styles.infoBox}>
          Undo the skip for this workout. It will return to its previous status.
        </p>
      ) : (
        <>
          <p className={styles.infoBox}>
            Mark this workout as skipped. It will count as done for the week.
          </p>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="skip-reason">
              Reason <span className={styles.optional}>(optional)</span>
            </label>
            <input
              id="skip-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={styles.input}
              placeholder="e.g. Travel, illness, rest day"
              maxLength={500}
              aria-describedby={error ? 'skip-error' : undefined}
            />
          </div>
        </>
      )}
      {error && (
        <p id="skip-error" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.cancel}
          onClick={() => {
            setOpen(false);
            setReason('');
            setError(null);
          }}
          disabled={loading}
        >
          Cancel
        </button>
        {skipped ? (
          <button
            type="button"
            className={styles.undo}
            onClick={handleUnskip}
            disabled={loading}
          >
            {loading ? 'Undoing…' : 'Undo Skip'}
          </button>
        ) : (
          <button
            type="button"
            className={styles.skip}
            onClick={handleSkip}
            disabled={loading}
          >
            {loading ? 'Skipping…' : 'Skip Workout'}
          </button>
        )}
      </div>
    </div>
  );
}
