'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { liftOccurrenceKey } from '@lifting-logbook/core';
import { upsertLiftOverride } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { followMovedMacrocycle, withMacrocycleId, writeFailureMessage } from '@/lib/macrocycleUrl';
import type { WorkoutLiftResponse } from '@lifting-logbook/types';
import styles from './ManageLiftsActions.module.css';

interface Props {
  program: string;
  macrocycleNum: number;
  /** The macrocycle's stable id, sent with the write (#1198). */
  macrocycleId?: string | undefined;
  workoutNum: number;
  lifts: WorkoutLiftResponse[];
}

export default function ManageLiftsActions({ program, macrocycleNum, macrocycleId, workoutNum, lifts }: Props) {
  const router = useRouter();
  // The row being removed, by its occurrence key: a day can plan one lift twice (#1027).
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove(lift: string, rowKey: string) {
    setPending(rowKey);
    setError(null);
    try {
      await upsertLiftOverride(program, macrocycleNum, workoutNum, { action: 'remove', lift }, macrocycleId);
      router.refresh();
    } catch (err) {
      logClientError('upsertLiftOverride', err, { action: 'remove', program, macrocycleNum, workoutNum, lift });
      if (followMovedMacrocycle(err)) return;
      setError(writeFailureMessage(err, `Failed to remove ${lift}. Please try again.`));
    } finally {
      setPending(null);
    }
  }

  const replaceUrl = (lift: string) =>
    withMacrocycleId(
      `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts/pick?action=replace&replacing=${encodeURIComponent(lift)}`,
      macrocycleId,
    );

  const editUrl = (lift: string) =>
    `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts/edit/${encodeURIComponent(lift)}`;

  if (lifts.length === 0) {
    return <p className={styles.empty}>No lifts planned for this workout.</p>;
  }

  return (
    <>
      {error && <p className={styles.error}>{error}</p>}
      <ul className={styles.liftList}>
        {lifts.map(({ lift, planned, occurrence }) => {
          const rowKey = liftOccurrenceKey(lift, occurrence);
          return (
            <li key={rowKey} className={styles.liftItem}>
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
                  onClick={() => void handleRemove(lift, rowKey)}
                >
                  {pending === rowKey ? '…' : 'Remove'}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
