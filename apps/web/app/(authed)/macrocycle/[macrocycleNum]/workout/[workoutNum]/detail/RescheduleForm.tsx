'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { rescheduleWorkout } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './RescheduleForm.module.css';

interface Props {
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  currentDate: string;
}

export default function RescheduleForm({ program, macrocycleNum, workoutNum, currentDate }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleMove() {
    if (!newDate) return;
    setLoading(true);
    setError(null);
    try {
      await rescheduleWorkout(program, macrocycleNum, workoutNum, newDate);
      setOpen(false);
      router.refresh();
    } catch (err) {
      logClientError('rescheduleWorkout', err, { program, macrocycleNum, workoutNum });
      setError('Failed to reschedule. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.trigger} onClick={() => setOpen(true)}>
        📅 Reschedule
      </button>
    );
  }

  return (
    <div className={styles.form}>
      <p className={styles.infoBox}>
        Move this workout to a different day. Lifts stay the same.
      </p>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="current-date">
          Current date
        </label>
        <input
          id="current-date"
          type="text"
          value={currentDate}
          readOnly
          className={styles.inputReadOnly}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="new-date">
          New date
        </label>
        <input
          id="new-date"
          type="date"
          value={newDate}
          onChange={(e) => setNewDate(e.target.value)}
          className={styles.input}
          aria-describedby={error ? 'reschedule-error' : undefined}
        />
      </div>
      {error && (
        <p id="reschedule-error" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.cancel}
          onClick={() => {
            setOpen(false);
            setNewDate('');
            setError(null);
          }}
          disabled={loading}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.move}
          onClick={handleMove}
          disabled={!newDate || loading}
        >
          {loading ? 'Moving…' : 'Move'}
        </button>
      </div>
    </div>
  );
}
