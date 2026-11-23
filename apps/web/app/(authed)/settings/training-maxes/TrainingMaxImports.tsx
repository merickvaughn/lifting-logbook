'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TrainingMaxImportBatchSummary } from '@lifting-logbook/types';
import { undoImport } from '@/lib/client-api';
import { localToday } from '@/lib/calendarDay';
import { undoSummary } from '@/lib/importUndo';
import { logClientError } from '@/lib/log-client-error';
import styles from './TrainingMaxImports.module.css';

/** When the import was committed, in UTC so the server and the browser render it alike. */
function committedAt(createdAt: string): string {
  return `${createdAt.slice(0, 10)} ${createdAt.slice(11, 16)} UTC`;
}

/**
 * The program's training-maxes imports, newest first, each with an Undo (#1405), so an import can
 * be undone after the wizard's Done step is gone. An undo asks first, and one runs at a time.
 * `failed` says the list couldn't be read, so no Undo is offered.
 */
export default function TrainingMaxImports({
  imports,
  failed = false,
}: {
  imports: TrainingMaxImportBatchSummary[];
  failed?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ kind: 'confirm' | 'trigger'; id: string } | 'result' | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());

  // Focus follows the control that replaced the one focused: the confirm button when it opens, the
  // Undo button again on Cancel, and the outcome once the undo is done.
  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget === 'result') resultRef.current?.focus();
    else if (focusTarget.kind === 'confirm') confirmButton.current?.focus();
    else triggers.current.get(focusTarget.id)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  async function handleUndo(batch: TrainingMaxImportBatchSummary) {
    setBusy(true);
    setError(null);
    try {
      const undone = await undoImport(batch.program, batch.id, localToday());
      setConfirming(null);
      setResult(undoSummary(undone));
      setFocusTarget('result');
      router.refresh();
    } catch (e) {
      logClientError('undoImport', e, { programId: batch.program, batchId: batch.id });
      setError({ id: batch.id, message: e instanceof Error ? e.message : 'Undo failed' });
      // The confirm button was disabled while the undo ran, which drops its focus: hand it back.
      setFocusTarget({ kind: 'confirm', id: batch.id });
    } finally {
      setBusy(false);
    }
  }

  if (imports.length === 0 && result === null && !failed) return null;

  return (
    <section className={styles.section} aria-labelledby="training-max-imports-heading">
      <h2 id="training-max-imports-heading" className={styles.heading}>
        Imported training maxes
      </h2>
      {failed ? (
        <p role="status" className={styles.failed}>
          Undoing a training-max import isn’t available right now. Refresh the page in a moment to try again.
        </p>
      ) : (
        <p className={styles.intro}>
          Undo an import to put back the maxes it changed. A max edited since the import is left as it is.
        </p>
      )}
      {/* Always mounted, so the outcome is announced when it appears. */}
      <div role="status">
        {result !== null && (
          <p ref={resultRef} tabIndex={-1} className={styles.result}>
            {result}
          </p>
        )}
      </div>
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
                      setFocusTarget({ kind: 'trigger', id: batch.id });
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
                    setFocusTarget({ kind: 'confirm', id: batch.id });
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
