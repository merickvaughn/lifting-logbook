'use client';

import { useEffect, useRef, useState } from 'react';
import type { MissingTrainingMaxResponse, WeightUnit } from '@lifting-logbook/types';
import { MissingMaxRow } from '@/components/missing-max/MissingMaxRow';
import rowStyles from '@/components/missing-max/MissingMaxRow.module.css';
import { fetchMissingTrainingMaxes } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './ImportMissingMaxes.module.css';

/**
 * "Lifts without a training max" under an import's result (#1246, #1273): the lifts this commit
 * wrote sets for that have no max and weren't answered "Don't ask again". Shown only when there
 * are any; a failed read leaves it out and is logged.
 *
 * Each answer removes its row, taking the focused button with it, so the block says what happened
 * in a status line and moves focus there.
 */
export default function ImportMissingMaxes({
  program,
  lifts,
  preferredUnit,
}: {
  program: string;
  /** The commit's `lifts`: stored lift ids. */
  lifts: readonly string[];
  preferredUnit?: WeightUnit;
}) {
  const [missing, setMissing] = useState<MissingTrainingMaxResponse[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let live = true;
    fetchMissingTrainingMaxes(program, lifts).then(
      (list) => {
        if (live) setMissing(list.filter((m) => !m.dismissed));
      },
      (err: unknown) => logClientError('fetchMissingTrainingMaxes', err, { program, source: 'import' }),
    );
    return () => {
      live = false;
    };
  }, [program, lifts]);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  if (!missing || (missing.length === 0 && !notice)) return null;

  function answered(liftId: string, text: string) {
    setMissing((prev) => prev && prev.filter((m) => m.liftId !== liftId));
    setNotice((prev) => ({ text, key: (prev?.key ?? 0) + 1 }));
  }

  const status = notice && (
    <p key={notice.key} ref={noticeRef} tabIndex={-1} role="status" className={styles.intro}>
      {notice.text}
    </p>
  );

  // The last lift was just answered: keep only the status line, so focus has somewhere to go.
  if (missing.length === 0) return <div className={styles.block}>{status}</div>;

  return (
    <section className={styles.block} aria-labelledby="import-missing-maxes-heading">
      {/* The result step has no h2 of its own ("Import complete" is a paragraph), so this follows the h1. */}
      <h2 id="import-missing-maxes-heading" className={styles.heading}>
        Lifts without a training max
      </h2>
      <p className={styles.intro}>
        This import logged sets for these lifts, but they have no training max, so progression skips
        them.
      </p>
      {status}
      <ul className={rowStyles.list}>
        {missing.map((entry) => (
          <MissingMaxRow
            key={entry.liftId}
            entry={entry}
            program={program}
            source="import"
            preferredUnit={preferredUnit}
            onSetUp={() => answered(entry.liftId, `Training max set up for ${entry.name}.`)}
            onDismissedChange={(liftId) => answered(liftId, `${entry.name} won't be asked about again.`)}
          />
        ))}
      </ul>
    </section>
  );
}
