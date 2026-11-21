'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isWorkoutSlot } from '@lifting-logbook/core';
import { SUPPLEMENT_SLOTS } from '@lifting-logbook/types';
import type { SupplementCatalogEntry, SupplementItem } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import { createSupplementItem, fetchSupplementCatalog, removeSupplementItem, updateSupplementItem } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import {
  SHORT_NOTE_MAX,
  SLOT_OPTION_LABEL,
  autofill,
  itemValues,
  newDose,
  presetValues,
  toBody,
  trackName,
  validate,
  type AutofillField,
  type FormValues,
  type Preset,
} from '@/lib/supplementForm';
import type { Stack } from '@/lib/supplementsView';
import styles from './supplements.module.css';

export type FormMode = { kind: 'add'; preset: Preset } | { kind: 'edit'; item: SupplementItem };

interface Props {
  stack: Stack;
  mode: FormMode;
  /** The day type the page shows; the `+ Add to this day` preset ticks it. */
  dayTypeId: string;
  /** Cancel, or Esc: back to what opened the form (the item's detail panel for an Edit). */
  onCancel: () => void;
  /** × and a successful save: close everything. */
  onDismiss: () => void;
}

const LOOKUP_DELAY_MS = 250;

const Suggested = ({ show }: { show: boolean }) => (show ? <span className={styles.suggestedTag}>SUGGESTED</span> : null);

/**
 * The Add/Edit supplement form, a native modal `<dialog>`. Typing a name looks it up in the shared
 * catalog and fills, in place, the fields the lifter hasn't typed in (`autofill`).
 */
export default function SupplementForm({ stack, mode, dayTypeId, onCancel, onDismiss }: Props) {
  const editing = mode.kind === 'edit' ? mode.item : undefined;
  const ref = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const amountRefs = useRef<(HTMLInputElement | null)[]>([]);
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => (editing ? itemValues(editing) : presetValues(mode.kind === 'add' ? mode.preset : 'daily', dayTypeId)));
  // Fields the lifter has typed in; autofill leaves these alone.
  const typed = useRef(new Set<string>());
  const [suggested, setSuggested] = useState<ReadonlySet<AutofillField>>(new Set());
  const [lookup, setLookup] = useState<{ entry?: SupplementCatalogEntry; filled: number } | undefined>();
  const [focusRow, setFocusRow] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (focusRow !== undefined) amountRefs.current[focusRow]?.focus();
  }, [focusRow, values.doses.length]);

  // Look the name up once the lifter pauses. An edit looks nothing up until the name changes.
  const name = values.name.trim();
  useEffect(() => {
    if (name === '' || name === editing?.name) {
      setLookup(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      fetchSupplementCatalog(name).then(
        (entries) => {
          if (!current) return;
          const entry = entries[0];
          if (!entry) return setLookup({ filled: 0 });
          setValues((prev) => {
            const result = autofill(prev, typed.current, entry, mode.kind, stack);
            setLookup({ entry, filled: result.filled.length });
            setSuggested((was) => new Set([...[...was].filter((f) => !typed.current.has(f)), ...result.filled]));
            return result.values;
          });
        },
        (err: unknown) => {
          // A failed lookup only means no autofill; the lifter can still fill the form in.
          logClientError('supplements.catalogLookup', err);
          if (current) setLookup(undefined);
        },
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // The lookup follows the name only: `stack` and `mode` don't change while the form is open.
  }, [name]);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K], field?: AutofillField) => {
    if (field) typed.current.add(field);
    setValues((v) => ({ ...v, [key]: value }));
  };
  const setDose = (i: number, patch: Partial<FormValues['doses'][number]>, field?: AutofillField) => {
    if (field && i === 0) typed.current.add(field);
    setValues((v) => ({ ...v, doses: v.doses.map((d, n) => (n === i ? { ...d, ...patch } : d)) }));
  };
  const setLink = (i: number, patch: Partial<FormValues['links'][number]>) => {
    typed.current.add('links');
    setValues((v) => ({ ...v, links: v.links.map((l, n) => (n === i ? { ...l, ...patch, auto: false } : l)) }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validate(values);
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(undefined);
    const op = editing ? 'supplements.editItem' : 'supplements.addItem';
    try {
      const body = toBody(values, { item: editing, entry: lookup?.entry });
      if (editing) await updateSupplementItem(editing.id, body, localToday());
      else await createSupplementItem(body, localToday());
      router.refresh();
      onDismiss();
    } catch (err) {
      logClientError(op, err, editing ? { itemId: editing.id } : undefined);
      setError(`Couldn’t ${editing ? 'save' : 'add'} the supplement. What you entered is still here; try again.`);
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    if (!confirmRemove) return setConfirmRemove(true);
    setBusy(true);
    setError(undefined);
    try {
      await removeSupplementItem(editing.id, localToday());
      router.refresh();
      onDismiss();
    } catch (err) {
      logClientError('supplements.removeItem', err, { itemId: editing.id });
      setError('Couldn’t remove the supplement. Try again.');
      setConfirmRemove(false);
      setBusy(false);
    }
  }

  const title = editing ? `Edit ${editing.name}` : 'Add supplement';
  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby="supp-form-title" onClose={onCancel}>
      <header className={styles.dialogHeader}>
        <div>
          <h2 id="supp-form-title">{title}</h2>
          <p className={styles.muted}>
            {editing ? 'Changes save to your stack' : 'Start typing a name; the rest fills in from the shared catalog'}
          </p>
        </div>
        <button type="button" className={styles.close} aria-label="Close" onClick={onDismiss}>
          ×
        </button>
      </header>

      <form className={styles.form} onSubmit={submit}>
        <label>
          Name
          <input ref={nameRef} required placeholder="e.g. Creatine monohydrate" value={values.name} onChange={(e) => {
            const next = e.target.value;
            setValues((v) => ({ ...v, name: next, links: trackName(stack, v.links, next) }));
          }} />
        </label>
        {lookup?.entry && lookup.filled > 0 && (
          <p className={styles.infoBanner} role="status">
            Filled {lookup.filled} field{lookup.filled === 1 ? '' : 's'} from the shared catalog
            {editing ? '' : '; label facts, uses and sources will be attached'}. Blue fields are suggestions; change anything.
          </p>
        )}
        {name !== '' && name !== editing?.name && lookup && !lookup.entry && (
          <p className={styles.noMatchBanner} role="status">
            Not in the shared catalog.
          </p>
        )}

        <label>
          Key compound <Suggested show={suggested.has('keyCompound')} />
          <input placeholder="e.g. Anthocyanins, 300 mg caffeine" value={values.keyCompound} onChange={(e) => set('keyCompound', e.target.value, 'keyCompound')} />
        </label>

        <fieldset className={styles.doses}>
          <legend>
            When and how much <span className={styles.muted}>(add a row for each time you take it)</span>
          </legend>
          {values.doses.map((d, i) => (
            <div key={i} className={styles.doseRow}>
              <label>
                Slot <Suggested show={i === 0 && suggested.has('slot')} />
                <select value={d.slot} onChange={(e) => setDose(i, { slot: SUPPLEMENT_SLOTS.find((s) => s === e.target.value) ?? d.slot }, 'slot')}>
                  {SUPPLEMENT_SLOTS.map((s) => (
                    <option key={s} value={s}>
                      {SLOT_OPTION_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount <Suggested show={i === 0 && suggested.has('amount')} />
                <input ref={(el) => { amountRefs.current[i] = el; }} placeholder="e.g. 5 g" value={d.amount} onChange={(e) => setDose(i, { amount: e.target.value }, 'amount')} />
              </label>
              <label>
                Servings
                <input type="number" inputMode="decimal" min="0" step="any" value={d.servings} onChange={(e) => setDose(i, { servings: e.target.value })} />
              </label>
              <button
                type="button"
                aria-label={`Remove dose ${i + 1}`}
                disabled={values.doses.length === 1}
                onClick={() => setValues((v) => ({ ...v, doses: v.doses.filter((_, n) => n !== i) }))}
              >
                ×
              </button>
              <div className={styles.dayTypes}>
                {stack.dayTypes.map((t) => (
                  <label key={t.id} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={d.dayTypes.includes(t.id)}
                      onChange={(e) => setDose(i, { dayTypes: e.target.checked ? [...d.dayTypes, t.id] : d.dayTypes.filter((x) => x !== t.id) })}
                    />
                    {t.name}
                  </label>
                ))}
                <span className={styles.muted}>{isWorkoutSlot(d.slot) ? 'Pick at least one.' : 'None ticked = every day.'}</span>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              setValues((v) => ({ ...v, doses: [...v.doses, newDose(dayTypeId)] }));
              setFocusRow(values.doses.length);
            }}
          >
            + Add another time
          </button>
        </fieldset>

        <div className={styles.twoCol}>
          <label>
            Typical range <Suggested show={suggested.has('typicalRange')} />
            <input placeholder="e.g. 3–5 g" value={values.typicalRange} onChange={(e) => set('typicalRange', e.target.value, 'typicalRange')} />
          </label>
          <label>
            Status
            <select value={values.status} onChange={(e) => set('status', e.target.value === 'pending' ? 'pending' : 'active')}>
              <option value="active">Active (taking it)</option>
              <option value="pending">Pending</option>
            </select>
          </label>
        </div>

        <label>
          Timing <Suggested show={suggested.has('timing')} />
          <input value={values.timing} onChange={(e) => set('timing', e.target.value, 'timing')} />
        </label>
        <label>
          Short note <span className={styles.muted}>(your words, shown in the list)</span>
          <input placeholder="e.g. In broth" maxLength={SHORT_NOTE_MAX} value={values.shortNote} onChange={(e) => set('shortNote', e.target.value)} />
        </label>
        <div className={styles.twoCol}>
          <label>
            Protein per serving (g)
            <input type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={values.protein} onChange={(e) => set('protein', e.target.value)} />
          </label>
          <label>
            Category
            <input value={values.category} onChange={(e) => set('category', e.target.value)} />
          </label>
        </div>
        <label>
          Long note <span className={styles.muted}>(shown in the detail panel)</span>
          <textarea placeholder="Why you take it, what you’ve noticed, brand to rebuy..." value={values.longNote} onChange={(e) => set('longNote', e.target.value)} />
        </label>

        <fieldset className={styles.links}>
          <legend>
            Product links <Suggested show={suggested.has('links')} />{' '}
            <span className={styles.muted}>(where you buy it; shown under “How you take it”)</span>
          </legend>
          {values.links.length === 0 && <p className={styles.muted}>No links yet.</p>}
          {values.links.map((l, i) => (
            <div key={i} className={styles.linkRow}>
              <input aria-label={`Link ${i + 1} label`} placeholder="Amazon" maxLength={60} value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />
              <input aria-label={`Link ${i + 1} URL`} placeholder="https://www.amazon.com/dp/…" value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} />
              <button
                type="button"
                aria-label={`Remove link ${i + 1}`}
                onClick={() => {
                  typed.current.add('links');
                  setValues((v) => ({ ...v, links: v.links.filter((_, n) => n !== i) }));
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              typed.current.add('links');
              setValues((v) => ({ ...v, links: [...v.links, { label: '', url: '', auto: false }] }));
            }}
          >
            + Add link
          </button>
        </fieldset>

        {error && <p role="alert">{error}</p>}
        <div className={styles.formButtons}>
          <button type="submit" disabled={busy}>
            {editing ? 'Save' : 'Add'}
          </button>
          <button type="button" disabled={busy} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          {editing && (
            <button type="button" className={styles.danger} disabled={busy} onClick={remove}>
              {confirmRemove ? 'Tap again to remove' : 'Remove'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
