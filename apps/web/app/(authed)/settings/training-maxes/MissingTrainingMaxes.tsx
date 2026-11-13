'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MissingTrainingMaxResponse } from '@lifting-logbook/types';
import { MissingMaxRow } from '@/components/missing-max/MissingMaxRow';
import rowStyles from '@/components/missing-max/MissingMaxRow.module.css';
import { fetchMissingTrainingMaxes } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './TrainingMaxesForm.module.css';

/**
 * "Lifts without a training max" (#1246, #1271): lifts with logged sets and no max, so
 * progression skips them. Shown only when there are any; a failed read leaves it out and is
 * logged. Lifts answered "Don't ask again" sit under a collapsed "Hidden from prompts".
 */
export default function MissingTrainingMaxes({ program }: { program: string }) {
  const router = useRouter();
  const [missing, setMissing] = useState<MissingTrainingMaxResponse[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchMissingTrainingMaxes(program).then(
      (list) => {
        if (live) setMissing(list);
      },
      (err: unknown) => logClientError('fetchMissingTrainingMaxes', err, { program, source: 'settings' }),
    );
    return () => {
      live = false;
    };
  }, [program]);

  if (!missing || missing.length === 0) return null;

  function setUp(lift: string) {
    setMissing((prev) => prev?.filter((m) => m.lift !== lift) ?? null);
    // The table below reads maxes on the server; refresh it to show the new one.
    router.refresh();
  }

  function setDismissed(liftId: string, dismissed: boolean) {
    setMissing((prev) => prev?.map((m) => (m.liftId === liftId ? { ...m, dismissed } : m)) ?? null);
  }

  const rows = (list: MissingTrainingMaxResponse[]) => (
    <ul className={rowStyles.list}>
      {list.map((entry) => (
        <MissingMaxRow
          key={entry.liftId}
          program={program}
          entry={entry}
          onSetUp={setUp}
          onDismissedChange={setDismissed}
        />
      ))}
    </ul>
  );
  const asking = missing.filter((m) => !m.dismissed);
  const hidden = missing.filter((m) => m.dismissed);

  return (
    <section className={styles.container} aria-labelledby="missing-maxes-heading">
      <h2 id="missing-maxes-heading" className={styles.heading}>
        Lifts without a training max
      </h2>
      <p className={styles.intro}>
        These lifts have logged sets but no training max, so progression skips them.
      </p>
      {asking.length > 0 && rows(asking)}
      {hidden.length > 0 && (
        <details className={styles.hidden}>
          <summary>Hidden from prompts ({hidden.length})</summary>
          {rows(hidden)}
        </details>
      )}
    </section>
  );
}
