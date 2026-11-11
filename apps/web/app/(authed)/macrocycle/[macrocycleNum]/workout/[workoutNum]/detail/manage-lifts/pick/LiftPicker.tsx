'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { upsertLiftOverride } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { followMovedMacrocycle, writeFailureMessage } from '@/lib/macrocycleUrl';
import styles from './LiftPicker.module.css';

interface Props {
  program: string;
  macrocycleNum: number;
  /** The macrocycle's stable id, sent with the write (#1198). */
  macrocycleId?: string | undefined;
  workoutNum: number;
  action: 'add' | 'replace';
  replacing?: string;
  catalog: string[];
  backHref: string;
}

export default function LiftPicker({
  program,
  macrocycleNum,
  macrocycleId,
  workoutNum,
  action,
  replacing,
  catalog,
  backHref,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = catalog.filter((lift) =>
    lift.toLowerCase().includes(query.toLowerCase()),
  );

  async function handleSelect(lift: string) {
    setPending(lift);
    setError(null);
    try {
      if (action === 'replace' && replacing) {
        await upsertLiftOverride(program, macrocycleNum, workoutNum, {
          action: 'replace',
          lift: replacing,
          replacedBy: lift,
        }, macrocycleId);
      } else {
        await upsertLiftOverride(program, macrocycleNum, workoutNum, { action: 'add', lift }, macrocycleId);
      }
      router.push(backHref);
      router.refresh();
    } catch (err) {
      // Log it so a production write failure (CORS, 5xx, auth expiry) is diagnosable rather
      // than a silently swallowed unhandled rejection (#783). The user stays on the picker to
      // retry, and sees why unless the page is reloading at the macrocycle's new number.
      logClientError('upsertLiftOverride', err, {
        action: action === 'replace' && replacing ? 'replace' : 'add',
        program,
        macrocycleNum,
        workoutNum,
        lift,
      });
      if (!followMovedMacrocycle(err)) setError(writeFailureMessage(err, `Failed to save ${lift}. Please try again.`));
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      <input
        type="search"
        placeholder="Search lifts…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={styles.searchInput}
        autoFocus
      />

      {error && <p className={styles.error} role="alert">{error}</p>}

      <ul className={styles.liftList}>
        {filtered.length === 0 && (
          <li className={styles.noResults}>No lifts match "{query}"</li>
        )}
        {filtered.map((lift) => (
          <li key={lift} className={styles.liftItem}>
            <button
              type="button"
              className={styles.liftButton}
              disabled={pending !== null}
              onClick={() => void handleSelect(lift)}
            >
              {lift}
              {pending === lift && <span className={styles.spinner}> …</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
