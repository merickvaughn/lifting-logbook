'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ImportUndoResponse, TrainingMaxImportBatchSummary } from '@lifting-logbook/types';
import { undoImport } from '@/lib/client-api';
import { localToday } from '@/lib/calendarDay';
import { logClientError } from '@/lib/log-client-error';
import styles from './TrainingMaxImports.module.css';

/** An undo's outcome, worded as the import wizard and History word it. */
function undoSummary(result: ImportUndoResponse): string {
  return (
    `Undo complete: ${result.restored} restored` +
    (result.skipped > 0 ? `, ${result.skipped} skipped` : '') +
    (result.flagged.length > 0 ? `, ${result.flagged.length} flagged (modified since import)` : '') +
    '.'
  );
}

/** When the import was committed, in UTC so the server and the browser render it alike. */
function committedAt(createdAt: string): string {
  return `${createdAt.slice(0, 10)} ${createdAt.slice(11, 16)} UTC`;
}

/**
 * The program's training-maxes imports, newest first, each with an Undo (#1405), so an import can
 * be undone after the wizard's Done step is gone. An undo asks first, and one runs at a time.
 */
export default function TrainingMaxImports({ imports }: { imports: TrainingMaxImportBatchSummary[] }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState<string | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());

  // Focus moves to the confirm button when it opens, back to its Undo button on Cancel, and to the
  // outcome once the undo is done.
  useEffect(() => {
    if (confirming !== null) confirmButton.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (cancelled === null) return;
    triggers.current.get(cancelled)?.focus();
    setCancelled(null);
  }, [cancelled]);
  useEffect(() => {
    if (result !== null) resultRef.current?.focus();
  }, [result]);

  async function handleUndo(batch: TrainingMaxImportBatchSummary) {
    setBusy(true);
    setError(null);
    try {
      const undone = await undoImport(batch.program, batch.id, localToday());
      setConfirming(null);
      setResult(undoSummary(undone));
      router.refresh();
    } catch (e) {
      logClientError('undoImport', e, { programId: batch.program, batchId: batch.id });
      setError({ id: batch.id, message: e instanceof Error ? e.message : 'Undo failed' });
    } finally {
      setBusy(false);
    }
  }

  if (imports.length === 0 && result === null) return null;

  return (
    <section className={styles.section} aria-labelledby="training-max-imports-heading">
      <h2 id="training-max-imports-heading" className={styles.heading}>
        Imported training maxes
      </h2>
      <p className={styles.intro}>
        Undo an import to put back the maxes it changed. A max edited since the import is left as it is.
      </p>
      {result !== null && (
        <p ref={resultRef} tabIndex={-1} role="status" className={styles.result}>
          {result}
        </p>
      )}
      <ul className={styles.list}>
        {imports.map((batch) => {
          const when = committedAt(batch.createdAt);
          const question = `undo-question-${batch.id}`;
          return (
            <li key={batch.id} className={styles.item}>
              <span>
                Import of <time dateTime={batch.createdAt}>{when}</time>
              </span>
              {confirming === batch.id ? (
                <>
                  <span id={question}>Undo this import?</span>
                  <button
                    ref={confirmButton}
                    type="button"
                    className={styles.button}
                    aria-describedby={question}
                    onClick={() => handleUndo(batch)}
                    disabled={busy}
                  >
                    {busy ? 'Undoing…' : 'Undo import'}
                  </button>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => {
                      setConfirming(null);
                      setCancelled(batch.id);
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  ref={(el) => {
                    if (el) triggers.current.set(batch.id, el);
                    else triggers.current.delete(batch.id);
                  }}
                  type="button"
                  className={styles.button}
                  aria-label={`Undo the import of ${when}`}
                  onClick={() => {
                    setConfirming(batch.id);
                    setError(null);
                    setResult(null);
                  }}
                  disabled={busy}
                >
                  Undo import
                </button>
              )}
              {error?.id === batch.id && (
                <p role="alert" className={styles.error}>
                  {error.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
