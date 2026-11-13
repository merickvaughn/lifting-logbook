'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MissingTrainingMaxResponse, WeightUnit } from '@lifting-logbook/types';
import { MissingMaxRow } from '@/components/missing-max/MissingMaxRow';
import rowStyles from '@/components/missing-max/MissingMaxRow.module.css';
import { fetchMissingTrainingMaxes } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './TrainingMaxesForm.module.css';

/**
 * "Lifts without a training max" (#1246, #1271): lifts with logged sets and no max, so
 * progression skips them. Shown only when there are any; a failed read leaves it out and is
 * logged. Lifts answered "Don't ask again" sit under a collapsed "Hidden from prompts".
 *
 * Each answer moves or removes its row, taking the focused button with it, so the section says
 * what happened in a status line and moves focus there.
 */
export default function MissingTrainingMaxes({
  program,
  preferredUnit,
  step,
}: {
  program: string;
  preferredUnit: WeightUnit;
  step: number;
}) {
  const router = useRouter();
  const [missing, setMissing] = useState<MissingTrainingMaxResponse[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);

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

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  if (!missing || (missing.length === 0 && !notice)) return null;

  const announce = (text: string) => setNotice((prev) => ({ text, key: (prev?.key ?? 0) + 1 }));

  function setUp(lift: string) {
    setMissing((prev) => prev?.filter((m) => m.lift !== lift) ?? null);
    announce(`Training max set up for ${lift}.`);
    // The table below reads maxes on the server; refresh it to show the new one.
    router.refresh();
  }

  function setDismissed(liftId: string, dismissed: boolean) {
    const lift = missing?.find((m) => m.liftId === liftId)?.lift ?? liftId;
    setMissing((prev) => prev?.map((m) => (m.liftId === liftId ? { ...m, dismissed } : m)) ?? null);
    announce(dismissed ? `${lift} hidden from prompts.` : `${lift} will be asked about again.`);
  }

  const rows = (list: MissingTrainingMaxResponse[]) => (
    <ul className={rowStyles.list}>
      {list.map((entry) => (
        <MissingMaxRow
          key={entry.liftId}
          entry={entry}
          program={program}
          source="settings"
          preferredUnit={preferredUnit}
          step={step}
          onSetUp={setUp}
          onDismissedChange={setDismissed}
        />
      ))}
    </ul>
  );
  const asking = missing.filter((m) => !m.dismissed);
  const hidden = missing.filter((m) => m.dismissed);
  const status = notice && (
    <p key={notice.key} ref={noticeRef} tabIndex={-1} role="status" className={styles.intro}>
      {notice.text}
    </p>
  );

  // The last lift was just answered: keep only the status line, so focus has somewhere to go.
  if (missing.length === 0) return <div className={styles.container}>{status}</div>;

  return (
    <section className={styles.container} aria-labelledby="missing-maxes-heading">
      <h2 id="missing-maxes-heading" className={styles.heading}>
        Lifts without a training max
      </h2>
      <p className={styles.intro}>
        These lifts have logged sets but no training max, so progression skips them.
      </p>
      {status}
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
