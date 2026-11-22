'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isWorkoutSlot } from '@lifting-logbook/core';
import { SUPPLEMENT_SLOTS, SUPPLEMENT_TEXT_MAX } from '@lifting-logbook/types';
import type { SupplementCatalogEntry, SupplementItem } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import { createSupplementItem, fetchSupplementCatalog, removeSupplementItem, setSupplementStatus, updateSupplementItem } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import {
  SHORT_NOTE_MAX,
  SLOT_OPTION_LABEL,
  autofill,
  candidateItem,
  itemValues,
  newDose,
  overlapsFor,
  presetValues,
  replaceValues,
  sharesLine,
  sharesSlotWith,
  toBody,
  trackName,
  validate,
  type AutofillField,
  type FormValues,
  type Preset,
  type ReplaceHow,
} from '@/lib/supplementForm';
import type { Stack } from '@/lib/supplementsView';
import styles from './supplements.module.css';

/** `replace` is an Add that starts from `item`'s slot and day types and offers to replace it (#1411). */
export type FormMode = { kind: 'add'; preset: Preset } | { kind: 'edit'; item: SupplementItem } | { kind: 'replace'; item: SupplementItem };

interface Props {
  stack: Stack;
  mode: FormMode;
  /** The day type the page shows; the `+ Add to this day` preset ticks it. */
  dayTypeId: string;
  /** Cancel, or Esc: back to what opened the form (the item's detail panel for an Edit). */
  onCancel: () => void;
  /** × and a successful save: close everything. A save says what it did, for the page to announce. */
  onDismiss: (done?: string) => void;
}

const LOOKUP_DELAY_MS = 250;

/** A finished lookup: the entry matched (none when the name isn't in the catalog), for which name. */
interface Lookup {
  name: string;
  entry?: SupplementCatalogEntry;
  filled: number;
}

interface FormState {
  values: FormValues;
  suggested: ReadonlySet<AutofillField>;
  lookup?: Lookup;
}

const without = (set: ReadonlySet<AutofillField>, field: AutofillField) => (set.has(field) ? new Set([...set].filter((f) => f !== field)) : set);

const Suggested = ({ show }: { show: boolean }) => (show ? <span className={styles.suggestedTag}>SUGGESTED</span> : null);

/**
 * The Add/Edit supplement form, a native modal `<dialog>`. Typing a name looks it up in the shared
 * catalog and fills, in place, the fields the lifter hasn't typed in (`autofill`).
 */
export default function SupplementForm({ stack, mode, dayTypeId, onCancel, onDismiss }: Props) {
  const editing = mode.kind === 'edit' ? mode.item : undefined;
  const replacing = mode.kind === 'replace' ? mode.item : undefined;
  const ref = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const amountRefs = useRef<(HTMLInputElement | null)[]>([]);
  const router = useRouter();
  // Values, their SUGGESTED tags and the last lookup are one state, so an autofill is one pure update.
  const [form, setForm] = useState<FormState>(() => ({
    values: editing ? itemValues(editing) : replacing ? replaceValues(replacing, dayTypeId) : presetValues(mode.kind === 'add' ? mode.preset : 'daily', dayTypeId),
    suggested: new Set(),
  }));
  const { values, suggested, lookup } = form;
  const setValues = (update: (v: FormValues) => FormValues) => setForm((f) => ({ ...f, values: update(f.values) }));
  const setLookup = (next: Lookup | undefined) => setForm((f) => ({ ...f, lookup: next }));
  // Fields the lifter has typed in; autofill leaves these alone. A replace keeps the replaced
  // item's slot and day types, as if the lifter had chosen them, so a catalog match can't move them.
  const typed = useRef(new Set<string>(replacing ? ['slot'] : []));
  // The items on the stack when the form opened: an item this form adds isn't one to replace.
  const openedWith = useRef(new Set(stack.items.map((i) => i.id)));
  const tryAgainRef = useRef<HTMLButtonElement>(null);
  // Lookups already answered, by name: the catalog doesn't change while the form is open.
  const answers = useRef(new Map<string, SupplementCatalogEntry[]>());
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
    if (focusRow === undefined) return;
    amountRefs.current[focusRow]?.focus();
    // Once only: a later change in the number of rows must not move focus again.
    setFocusRow(undefined);
  }, [focusRow, values.doses.length]);

  // Look the name up once the lifter pauses. An edit looks nothing up until the name changes.
  const name = values.name.trim();
  const editingName = editing?.name;
  useEffect(() => {
    if (name === '' || name === editingName) {
      setLookup(undefined);
      return;
    }
    let current = true;
    const answered = (entries: SupplementCatalogEntry[]) => {
      if (!current) return;
      const entry = entries[0];
      if (!entry) return setLookup({ name, filled: 0 });
      setForm((f) => {
        const result = autofill(f.values, typed.current, entry, editing ? 'edit' : 'add', stack, dayTypeId);
        return {
          values: result.values,
          lookup: { name, entry, filled: result.filled.length },
          suggested: new Set([...[...f.suggested].filter((field) => !typed.current.has(field)), ...result.filled]),
        };
      });
    };
    const timer = setTimeout(() => {
      const known = answers.current.get(name);
      if (known) return answered(known);
      fetchSupplementCatalog(name).then(
        (entries) => {
          answers.current.set(name, entries);
          answered(entries);
        },
        (err: unknown) => {
          // A failed lookup only means no autofill; the lifter can still fill the form in.
          // A lookup the lifter has already typed past isn't worth an error report.
          if (!current) return;
          logClientError('supplements.catalogLookup', err);
          setLookup(undefined);
        },
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [name, editingName, editing, stack, dayTypeId]);

  // The entry matched for the name as it is now; a match for an earlier name is never saved.
  const matched = lookup?.name === name ? lookup.entry : undefined;

  // Replace what you already take? (#1411) The item being replaced is always listed first, ticked.
  // The rest are active items sharing an ingredient with what's being added; only same-slot ones
  // it supplies at least as much of start ticked (core's `findOverlaps`), and none when the new
  // item is itself pending, since that would set aside something the lifter takes for something
  // they don't yet. A tick the lifter has changed is kept in `ticks`; every other row follows the
  // rule as the form changes. Only the fields the overlap reads are dependencies, so typing a note
  // doesn't recompute it.
  const { doses, status, protein } = values;
  const candidate = useMemo(() => candidateItem({ doses, status, protein }, matched), [doses, status, protein, matched]);
  const overlaps = useMemo(
    () =>
      editing ? [] : overlapsFor(candidate, stack.items.filter((i) => openedWith.current.has(i.id) && i.id !== replacing?.id)),
    [candidate, stack.items, editing, replacing?.id],
  );
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [how, setHow] = useState<ReplaceHow>('pending');
  const replaceRows = useMemo(
    () => [
      ...(replacing
        ? [{ item: replacing, sameSlot: sharesSlotWith(candidate, replacing), line: 'You chose to replace this', on: ticks[replacing.id] ?? true }]
        : []),
      ...overlaps.map((o) => ({
        item: o.item,
        sameSlot: o.sameSlot,
        line: sharesLine(o, candidate, dayTypeId),
        on: ticks[o.item.id] ?? (o.preselect && status === 'active'),
      })),
    ],
    [replacing, candidate, overlaps, ticks, status, dayTypeId],
  );
  // The add went through but dealing with the replaced items didn't: the form can't add again, and
  // `ids` holds only the items still to deal with.
  const [added, setAdded] = useState<{ ids: string[]; how: ReplaceHow } | undefined>();
  useEffect(() => {
    // The form that had focus is gone, so focus the way forward.
    if (added) tryAgainRef.current?.focus();
  }, [added]);

  const typedIn = (field: AutofillField) => {
    typed.current.add(field);
    setForm((f) => ({ ...f, suggested: without(f.suggested, field) }));
  };
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K], field?: AutofillField) => {
    if (field) typedIn(field);
    setValues((v) => ({ ...v, [key]: value }));
  };
  const setDose = (i: number, patch: Partial<FormValues['doses'][number]>, field?: AutofillField) => {
    if (field && i === 0) typedIn(field);
    setValues((v) => ({ ...v, doses: v.doses.map((d, n) => (n === i ? { ...d, ...patch } : d)) }));
  };
  const setLink = (i: number, patch: Partial<FormValues['links'][number]>) => {
    typedIn('links');
    setValues((v) => ({ ...v, links: v.links.map((l, n) => (n === i ? { ...l, ...patch, auto: false } : l)) }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validate(values);
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(undefined);
    const op = editing ? 'supplements.editItem' : 'supplements.addItem';
    const ids = replaceRows.filter((r) => r.on).map((r) => r.item.id);
    try {
      const body = toBody(values, { item: editing, entry: matched });
      if (editing) await updateSupplementItem(editing.id, body, localToday());
      else await createSupplementItem(body, localToday());
    } catch (err) {
      logClientError(op, err, editing ? { itemId: editing.id } : undefined);
      setError(`Couldn’t ${editing ? 'save' : 'add'} the supplement. What you entered is still here; try again.`);
      setBusy(false);
      return;
    }
    const savedName = values.name.trim();
    if (ids.length === 0) {
      router.refresh();
      return onDismiss(`${editing ? 'Saved' : 'Added'} ${savedName}.`);
    }
    await replaceThem(ids, how);
  }

  /**
   * The second step of a replace: the items it replaces go to Pending, or are removed (restorable
   * from History). Removal is one call per item, so a failure part-way leaves only the rest to retry.
   */
  async function replaceThem(ids: string[], choice: ReplaceHow) {
    setBusy(true);
    setError(undefined);
    let left = ids;
    try {
      if (choice === 'pending') await setSupplementStatus(ids, 'pending', localToday());
      else
        for (const id of ids) {
          await removeSupplementItem(id, localToday());
          left = left.filter((x) => x !== id);
        }
      router.refresh();
      const n = `${ids.length} item${ids.length === 1 ? '' : 's'}`;
      onDismiss(`Added ${values.name.trim()}; ${choice === 'pending' ? `moved ${n} to Pending` : `removed ${n}`}.`);
    } catch (err) {
      logClientError('supplements.replaceItems', err, { items: ids.length, left: left.length, how: choice });
      // The add went through, and a remove can have gone through for some, so the page re-reads the stack.
      router.refresh();
      setAdded({ ids: left, how: choice });
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
      onDismiss(`Removed ${editing.name}.`);
    } catch (err) {
      logClientError('supplements.removeItem', err, { itemId: editing.id });
      setError('Couldn’t remove the supplement. Try again.');
      setConfirmRemove(false);
      setBusy(false);
    }
  }

  const title = editing ? `Edit ${editing.name}` : 'Add supplement';
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="supp-form-title"
      aria-busy={busy}
      // While a save is in flight Esc doesn't close the form, so its outcome is never lost (as BulkDialog).
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClose={onCancel}
    >
      <header className={styles.dialogHeader}>
        <div>
          <h2 id="supp-form-title">{title}</h2>
          <p className={styles.muted}>
            {editing ? 'Changes save to your stack' : 'Start typing a name; the rest fills in from the shared catalog'}
          </p>
        </div>
        <button type="button" className={styles.close} aria-label="Close" disabled={busy} onClick={() => onDismiss()}>
          ×
        </button>
      </header>

      {added ? (
        <div className={styles.form}>
          <p role="alert">
            Added {values.name.trim()}, but couldn’t {added.how === 'pending' ? 'move' : 'remove'} the items it replaces. Check the page for which
            are still active; you can try again.
          </p>
          <div className={styles.formButtons}>
            <button ref={tryAgainRef} type="button" disabled={busy} onClick={() => void replaceThem(added.ids, added.how)}>
              Try again
            </button>
            <button type="button" disabled={busy} onClick={() => onDismiss()}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className={styles.form} onSubmit={submit}>
          <label>
            Name
            <input ref={nameRef} required maxLength={SUPPLEMENT_TEXT_MAX.name} placeholder="e.g. Creatine monohydrate" value={values.name} onChange={(e) => {
              const next = e.target.value;
              setValues((v) => ({ ...v, name: next, links: trackName(stack, v.links, next) }));
            }} />
          </label>
          {matched && lookup && lookup.filled > 0 && (
            <p className={styles.infoBanner} role="status">
              Filled {lookup.filled} field{lookup.filled === 1 ? '' : 's'} from the shared catalog
              {editing ? '' : '; label facts, uses and sources will be attached'}. Blue fields are suggestions; change anything.
            </p>
          )}
          {name !== '' && lookup?.name === name && !lookup.entry && (
            <p className={styles.noMatchBanner} role="status">
              Not in the shared catalog.
            </p>
          )}

          <label>
            Key compound <Suggested show={suggested.has('keyCompound')} />
            <input maxLength={SUPPLEMENT_TEXT_MAX.name} placeholder="e.g. Anthocyanins, 300 mg caffeine" value={values.keyCompound} onChange={(e) => set('keyCompound', e.target.value, 'keyCompound')} />
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
                  <input ref={(el) => { amountRefs.current[i] = el; }} maxLength={SUPPLEMENT_TEXT_MAX.name} placeholder="e.g. 5 g" value={d.amount} onChange={(e) => setDose(i, { amount: e.target.value }, 'amount')} />
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
              <input maxLength={SUPPLEMENT_TEXT_MAX.name} placeholder="e.g. 3–5 g" value={values.typicalRange} onChange={(e) => set('typicalRange', e.target.value, 'typicalRange')} />
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
            <input maxLength={SUPPLEMENT_TEXT_MAX.name} value={values.timing} onChange={(e) => set('timing', e.target.value, 'timing')} />
          </label>
          <label>
            Short note <span className={styles.muted}>(your words, shown in the list)</span>
            <input placeholder="e.g. In broth" maxLength={SHORT_NOTE_MAX} value={values.shortNote} onChange={(e) => set('shortNote', e.target.value)} />
          </label>
          <div className={styles.twoCol}>
            <label>
              Protein per serving (g){editing?.parts && <span className={styles.muted}> (from its parts)</span>}
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder="0"
                disabled={editing?.parts !== undefined}
                value={values.protein}
                onChange={(e) => set('protein', e.target.value)}
              />
            </label>
            <label>
              Category
              <input maxLength={SUPPLEMENT_TEXT_MAX.name} value={values.category} onChange={(e) => set('category', e.target.value)} />
            </label>
          </div>
          <label>
            Long note <span className={styles.muted}>(shown in the detail panel)</span>
            <textarea maxLength={SUPPLEMENT_TEXT_MAX.text} placeholder="Why you take it, what you’ve noticed, brand to rebuy..." value={values.longNote} onChange={(e) => set('longNote', e.target.value)} />
          </label>

          <fieldset className={styles.links}>
            <legend>
              Product links <Suggested show={suggested.has('links')} />{' '}
              <span className={styles.muted}>(where you buy it; shown under “How you take it”)</span>
            </legend>
            {values.links.length === 0 && <p className={styles.muted}>No links yet.</p>}
            {values.links.map((l, i) => (
              <div key={i} className={styles.linkRow}>
                <input aria-label={`Link ${i + 1} label`} placeholder="Amazon" maxLength={SUPPLEMENT_TEXT_MAX.linkLabel} value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />
                <input aria-label={`Link ${i + 1} URL`} maxLength={SUPPLEMENT_TEXT_MAX.text} placeholder="https://www.amazon.com/dp/…" value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} />
                <button
                  type="button"
                  aria-label={`Remove link ${i + 1}`}
                  onClick={() => {
                    typedIn('links');
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
                typedIn('links');
                setValues((v) => ({ ...v, links: [...v.links, { label: '', url: '', auto: false }] }));
              }}
            >
              + Add link
            </button>
          </fieldset>

          {replaceRows.length > 0 && (
            <fieldset className={styles.replaceGroup}>
              <legend>Replace what you already take?</legend>
              {replaceRows.map((r) => (
                <label key={r.item.id} className={styles.replaceRow}>
                  <input type="checkbox" checked={r.on} onChange={(e) => setTicks((t) => ({ ...t, [r.item.id]: e.target.checked }))} />
                  <span>
                    <strong>{r.item.name}</strong>
                    {r.sameSlot && <span className={`${styles.pill} ${styles.pillStrong}`}>SAME SLOT</span>}
                    <span className={styles.line2}>{r.line}</span>
                  </span>
                </label>
              ))}
              <div className={styles.replaceHow} role="radiogroup" aria-label="What to do with them">
                <label>
                  <input type="radio" name="replace-how" checked={how === 'pending'} onChange={() => setHow('pending')} /> Move them to Pending{' '}
                  <span className={styles.muted}>(easy to switch back if this product disappears)</span>
                </label>
                <label>
                  <input type="radio" name="replace-how" checked={how === 'remove'} onChange={() => setHow('remove')} /> Remove them{' '}
                  <span className={styles.muted}>(restorable from History)</span>
                </label>
              </div>
            </fieldset>
          )}

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
      )}
    </dialog>
  );
}
