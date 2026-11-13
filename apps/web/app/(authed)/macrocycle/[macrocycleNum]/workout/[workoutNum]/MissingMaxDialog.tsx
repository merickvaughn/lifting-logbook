'use client';

import { useId, useRef, useState } from 'react';
import type { MissingTrainingMaxResponse, WeightUnit } from '@lifting-logbook/types';
import { initialValue, MissingMaxRow } from '@/components/missing-max/MissingMaxRow';
import rowStyles from '@/components/missing-max/MissingMaxRow.module.css';
import { updateTrainingMaxes } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { useFocusTrap } from '@/lib/useFocusTrap';
import styles from './MissingMaxDialog.module.css';

/**
 * After **Finish workout** (#1246, #1272): the lifts this workout logged that plan from a
 * training max and have none. Each row answers on its own; **Set up all** saves every row left
 * with a weight. Every way out (**Set up all**, **Not now**, Esc, or the last row answered) calls
 * `onDone`, which navigates, so finishing a workout is never held up.
 *
 * A hand-written modal with `useFocusTrap`, like the app's other dialogs: Jest's jsdom has no
 * `showModal`. Focus starts on the first weight input.
 */
export default function MissingMaxDialog({
  program,
  missing,
  unit,
  onDone,
}: {
  program: string;
  missing: readonly MissingTrainingMaxResponse[];
  unit: WeightUnit;
  onDone: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(missing);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(missing.map((m) => [m.liftId, initialValue(m)])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusTrap(dialogRef, { active: true, onEscape: onDone, returnFocus: () => null });

  function answered(liftId: string) {
    const left = rows.filter((m) => m.liftId !== liftId);
    setRows(left);
    if (left.length === 0) onDone();
  }

  async function setUpAll() {
    const maxes = rows.flatMap((m) => {
      const weight = Number(values[m.liftId]);
      return values[m.liftId] && Number.isFinite(weight) && weight > 0
        ? [{ lift: m.lift, weight, unit: m.estimate?.unit ?? 'lbs' }]
        : [];
    });
    if (maxes.length === 0) {
      onDone();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateTrainingMaxes(program, { maxes });
      onDone();
    } catch (err) {
      logClientError('updateTrainingMaxes', err, { program, source: 'workout', count: maxes.length });
      setError("Couldn't save the training maxes. Try again, or choose Not now.");
      setSaving(false);
    }
  }

  return (
    <div className={styles.overlay}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className={styles.title}>
          New lifts need a training max
        </h2>
        <p className={styles.intro}>
          Workouts plan these lifts from a training max, and they don&apos;t have one yet. Until they do, they plan
          at 0 and don&apos;t progress.
        </p>
        <ul className={rowStyles.list}>
          {rows.map((entry) => (
            <MissingMaxRow
              key={entry.liftId}
              entry={entry}
              program={program}
              source="workout"
              preferredUnit={unit}
              value={values[entry.liftId] ?? ''}
              onValueChange={(liftId, value) => setValues((prev) => ({ ...prev, [liftId]: value }))}
              onSetUp={() => answered(entry.liftId)}
              onDismissedChange={(liftId) => answered(liftId)}
            />
          ))}
        </ul>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.footer}>
          <button type="button" className={styles.secondary} onClick={onDone}>
            Not now
          </button>
          <button type="button" className={styles.primary} onClick={setUpAll} disabled={saving}>
            {saving ? 'Saving…' : 'Set up all'}
          </button>
        </div>
      </div>
    </div>
  );
}
