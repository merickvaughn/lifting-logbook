'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MissingTrainingMaxResponse, WeightUnit } from '@lifting-logbook/types';
import { initialValue, MissingMaxRow, parseWeight, rowUnit } from '@/components/missing-max/MissingMaxRow';
import rowStyles from '@/components/missing-max/MissingMaxRow.module.css';
import { updateTrainingMaxes } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { useFocusTrap } from '@/lib/useFocusTrap';
import styles from './MissingMaxDialog.module.css';

/**
 * After **Finish workout** (#1246, #1272): the lifts this workout logged that plan from a
 * training max and have none. Each row answers on its own; **Set up all** saves every row left
 * with a weight. Every way out (**Set up all**, **Not now**, Esc, or the last row answered) calls
 * `onDone` once, which navigates, so finishing a workout is never held up.
 *
 * A hand-written modal with `useFocusTrap`, like the app's other dialogs: Jest's jsdom has no
 * `showModal`. Focus starts on the first weight input, and moves to the next one as rows are
 * answered.
 */
export default function MissingMaxDialog({
  program,
  missing,
  unit,
  stepFor,
  onDone,
}: {
  program: string;
  missing: readonly MissingTrainingMaxResponse[];
  unit: WeightUnit;
  /** The weight step for a lift's input: its progression increment. */
  stepFor: (liftId: string) => number;
  onDone: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(missing);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(missing.map((m) => [m.liftId, initialValue(m)])),
  );
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [busyRows, setBusyRows] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const left = useRef(false);

  // Every exit leaves once: a second exit while the navigation lands does nothing.
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    onDone();
  }, [onDone]);

  useFocusTrap(dialogRef, { active: true, onEscape: leave, returnFocus: () => null });

  // The last row answered leaves.
  useEffect(() => {
    if (rows.length === 0) leave();
  }, [rows.length, leave]);

  // An answered row took focus with it: move it to the next row's input.
  useEffect(() => {
    if (rows.length > 0 && rows.length < missing.length) {
      dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    }
  }, [rows.length, missing.length]);

  // Functional updates: two rows answered at once each remove only their own (#1282 review).
  function answered(liftId: string, message: string) {
    setRows((prev) => prev.filter((m) => m.liftId !== liftId));
    setNotice(message);
  }

  function setBusy(liftId: string, busy: boolean) {
    setBusyRows((prev) => {
      const next = new Set(prev);
      if (busy) next.add(liftId);
      else next.delete(liftId);
      return next;
    });
  }

  async function setUpAll() {
    // An empty row is left for later; a row holding something that isn't a weight is refused.
    const refused = rows.filter((m) => (values[m.liftId] ?? '').trim() !== '' && parseWeight(values[m.liftId] ?? '') === null);
    if (refused.length > 0) {
      setInvalid(new Set(refused.map((m) => m.liftId)));
      setError(`Enter a positive number for ${refused.map((m) => m.lift).join(', ')}, or clear it.`);
      return;
    }
    const maxes = rows.flatMap((m) => {
      const weight = parseWeight(values[m.liftId] ?? '');
      return weight === null ? [] : [{ lift: m.lift, weight, unit: rowUnit(m) }];
    });
    if (maxes.length === 0) {
      leave();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateTrainingMaxes(program, { maxes });
      leave();
    } catch (err) {
      logClientError('updateTrainingMaxes', err, { program, source: 'workout', count: maxes.length });
      setError("Couldn't save the training maxes. Try again, or choose Not now.");
      setSaving(false);
    }
  }

  return (
    <div className={styles.overlay}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-intro`}
      >
        <h2 id={`${id}-title`} className={styles.title}>
          New lifts need a training max
        </h2>
        <p id={`${id}-intro`} className={styles.intro}>
          Workouts plan these lifts from a training max, and they don&apos;t have one yet. Until they do, they plan
          at 0 and don&apos;t progress.
        </p>
        <p role="status" className={styles.notice}>
          {notice}
        </p>
        <ul className={rowStyles.list}>
          {rows.map((entry) => (
            <MissingMaxRow
              key={entry.liftId}
              entry={entry}
              program={program}
              source="workout"
              preferredUnit={unit}
              step={stepFor(entry.liftId)}
              value={values[entry.liftId] ?? ''}
              onValueChange={(liftId, value) => {
                setValues((prev) => ({ ...prev, [liftId]: value }));
                setInvalid((prev) => {
                  const next = new Set(prev);
                  next.delete(liftId);
                  return next;
                });
              }}
              error={invalid.has(entry.liftId) ? 'Enter a positive number' : null}
              disabled={saving}
              onBusyChange={setBusy}
              onSetUp={(lift) => answered(entry.liftId, `Training max set up for ${lift}.`)}
              onDismissedChange={(liftId) => answered(liftId, `${entry.lift} won't be asked about again.`)}
            />
          ))}
        </ul>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.footer}>
          <button type="button" className={styles.secondary} onClick={leave}>
            Not now
          </button>
          <button type="button" className={styles.primary} onClick={setUpAll} disabled={saving || busyRows.size > 0}>
            {saving ? 'Saving…' : 'Set up all'}
          </button>
        </div>
      </div>
    </div>
  );
}
