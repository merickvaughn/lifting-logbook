'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { upsertLiftOverride } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import type { WorkoutLiftResponse } from '@lifting-logbook/types';
import styles from './ManageLiftsActions.module.css';

interface Props {
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  lifts: WorkoutLiftResponse[];
}

export default function ManageLiftsActions({ program, macrocycleNum, workoutNum, lifts }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove(lift: string) {
    setPending(lift);
    setError(null);
    try {
      await upsertLiftOverride(program, macrocycleNum, workoutNum, { action: 'remove', lift });
      router.refresh();
    } catch (err) {
      logClientError('upsertLiftOverride', err, { action: 'remove', program, macrocycleNum, workoutNum, lift });
      setError(`Failed to remove ${lift}. Please try again.`);
    } finally {
      setPending(null);
    }
  }

  const replaceUrl = (lift: string) =>
    `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts/pick?action=replace&replacing=${encodeURIComponent(lift)}`;

  const editUrl = (lift: string) =>
    `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts/edit/${encodeURIComponent(lift)}`;

  if (lifts.length === 0) {
    return <p className={styles.empty}>No lifts planned for this workout.</p>;
  }

  return (
    <>
      {error && <p className={styles.error}>{error}</p>}
      <ul className={styles.liftList}>
        {lifts.map(({ lift, planned }) => (
          <li key={lift} className={styles.liftItem}>
            <span className={styles.liftName}>
              {lift}
              {planned && <span className={styles.plannedBadge}>planned</span>}
            </span>
            <span className={styles.actions}>
              <Link href={editUrl(lift)} className={styles.btnSecondary}>
                Edit
              </Link>
              <Link href={replaceUrl(lift)} className={styles.btnSecondary}>
                Replace
              </Link>
              <button
                type="button"
                className={styles.btnDanger}
                disabled={pending !== null}
                onClick={() => void handleRemove(lift)}
              >
                {pending === lift ? '…' : 'Remove'}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
