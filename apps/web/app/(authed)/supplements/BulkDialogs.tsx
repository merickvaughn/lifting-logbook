'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isWorkoutSlot } from '@lifting-logbook/core';
import { SUPPLEMENT_SLOTS, SUPPLEMENT_TEXT_MAX } from '@lifting-logbook/types';
import type { SupplementSlot } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import { createSupplementMix, moveSupplementDoses } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { SLOT_OPTION_LABEL } from '@/lib/supplementForm';
import type { RowModel, Stack } from '@/lib/supplementsView';
import styles from './supplements.module.css';

interface Props {
  stack: Stack;
  /** The selected rows. */
  rows: RowModel[];
  /** Cancel, ×, or Esc: the selection and the dialog's input are kept by whoever reopens it. */
  onCancel: () => void;
  /** A successful write: the page clears the selection and closes the dialog. */
  onDone: () => void;
}

/** A native modal `<dialog>` with a title, subtitle and ×, closed by Esc like the Add/Edit form. */
function BulkDialog({ id, title, subtitle, onCancel, children }: { id: string; title: string; subtitle: string; onCancel: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={id} onClose={onCancel}>
      <header className={styles.dialogHeader}>
        <div>
          <h2 id={id}>{title}</h2>
          <p className={styles.muted}>{subtitle}</p>
        </div>
        <button type="button" className={styles.close} aria-label="Close" onClick={onCancel}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}

const itemsOf = (rows: RowModel[]) => [...new Map(rows.map((r) => [r.item.id, r.item])).values()];

/**
 * `Move to…`: each selected row is one time an item is taken (a dose, after FHIR Dosage), so only
 * the doses in the rows' own slots move. One `doses/move` per source slot, since the endpoint takes one.
 */
export function MoveDialog({ stack, rows, onCancel, onDone }: Props) {
  const router = useRouter();
  const [slot, setSlot] = useState<SupplementSlot>('pm');
  const [dayTypes, setDayTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isWorkoutSlot(slot) && dayTypes.length === 0) return setError(`Pick at least one day type for ${SLOT_OPTION_LABEL[slot]}.`);
    const bySlot = new Map<SupplementSlot, Set<string>>();
    for (const r of rows) if (r.slot) bySlot.set(r.slot, (bySlot.get(r.slot) ?? new Set()).add(r.item.id));
    if (bySlot.size === 0) return setError('None of the selected items has a time to move.');
    setBusy(true);
    setError(undefined);
    try {
      for (const [from, ids] of bySlot) await moveSupplementDoses({ itemIds: [...ids], from, to: slot, dayTypes }, localToday());
      router.refresh();
      onDone();
    } catch (err) {
      logClientError('supplements.bulkMove', err, { rows: rows.length, to: slot });
      setError('Couldn’t move them. Your choices are still here; try again.');
      setBusy(false);
    }
  }

  return (
    <BulkDialog
      id="supp-move-title"
      title={`Move ${rows.length} row${rows.length === 1 ? '' : 's'}`}
      subtitle="Each selected row is one time an item is taken; only those times move."
      onCancel={onCancel}
    >
      <form className={styles.form} onSubmit={submit}>
        <label>
          Slot
          <select value={slot} onChange={(e) => setSlot(SUPPLEMENT_SLOTS.find((s) => s === e.target.value) ?? slot)}>
            {SUPPLEMENT_SLOTS.map((s) => (
              <option key={s} value={s}>
                {SLOT_OPTION_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Day types</legend>
          <div className={styles.dayTypes}>
            {stack.dayTypes.map((t) => (
              <label key={t.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={dayTypes.includes(t.id)}
                  onChange={(e) => setDayTypes(e.target.checked ? [...dayTypes, t.id] : dayTypes.filter((x) => x !== t.id))}
                />
                {t.name}
              </label>
            ))}
            <span className={styles.muted}>{isWorkoutSlot(slot) ? 'Pick at least one.' : 'None ticked = every day.'}</span>
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <div className={styles.formButtons}>
          <button type="submit" disabled={busy}>
            Move
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </BulkDialog>
  );
}

/**
 * `Combine into mix…`: a Composite, after the pattern — the API makes one new item holding the
 * selected ones as parts, so totals and overlaps still count each part. Takes the name only; the
 * mix takes the first part's doses.
 */
export function CombineDialog({ rows, onCancel, onDone }: Omit<Props, 'stack'>) {
  const router = useRouter();
  const items = itemsOf(rows);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const mix = items.find((i) => i.parts !== undefined);
    if (items.length < 2) return setError('Pick two or more different items to combine.');
    if (mix) return setError(`${mix.name} is already a mix; split it first.`);
    setBusy(true);
    setError(undefined);
    try {
      await createSupplementMix(name.trim(), items.map((i) => i.id), localToday());
      router.refresh();
      onDone();
    } catch (err) {
      logClientError('supplements.combine', err, { items: items.length });
      setError('Couldn’t combine them. The name is still here; try again.');
      setBusy(false);
    }
  }

  return (
    <BulkDialog
      id="supp-combine-title"
      title="Combine into a mix"
      subtitle={`${items.map((i) => i.name).join(', ')} become one row; totals and overlaps still count each one.`}
      onCancel={onCancel}
    >
      <form className={styles.form} onSubmit={submit}>
        <label>
          Mix name
          <input
            required
            autoFocus
            maxLength={SUPPLEMENT_TEXT_MAX.name}
            placeholder="e.g. All-day broth"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className={styles.muted}>The mix takes the first item’s doses. Split the mix to get them back as separate items.</p>
        {error && <p role="alert">{error}</p>}
        <div className={styles.formButtons}>
          <button type="submit" disabled={busy}>
            Combine
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </BulkDialog>
  );
}
