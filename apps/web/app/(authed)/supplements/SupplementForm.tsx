'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isWorkoutSlot } from '@lifting-logbook/core';
import { SUPPLEMENT_SLOTS, SUPPLEMENT_TEXT_MAX } from '@lifting-logbook/types';
import type { SupplementCatalogEntry, SupplementItem, SupplementLabelLookupResponse } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import {
  createSupplementItem,
  fetchSupplementAiSuggestion,
  fetchSupplementCatalog,
  fetchSupplementLabelLookup,
  removeSupplementItem,
  removeSupplementItems,
  setSupplementStatus,
  updateSupplementItem,
} from '@/lib/client-api';
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
  suggestionEntry,
  toBody,
  trackName,
  validate,
  type AutofillField,
  type FormValues,
  type Preset,
  type ReplaceHow,
  type TieredSuggestion,
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
  /** A tier 2 (product label) or tier 3 (AI) suggestion that filled the form instead of an entry (#1381). */
  suggested?: TieredSuggestion;
  filled: number;
  /** The catalog lookup failed. An add still goes on to tiers 2 and 3, which don't need it. */
  catalogFailed?: boolean;
  /**
   * After a catalog miss on an add: what the product label lookup said, `limited` when the lifter
   * has used this hour's lookups. Tier 3 is offered once it's set.
   */
  label?: 'none' | 'unavailable' | 'limited';
  /** With `limited`: how long until the lifter can look labels up again. */
  retryAfterMinutes?: number;
}

/**
 * What an AI suggestion filled (#1381): the fields it filled that the lifter hasn't changed since,
 * and what the form held before. When the name moves away from `name` those fields go back, so no
 * AI value can be saved without the item being marked unverified.
 */
interface AiFill {
  name: string;
  suggested: TieredSuggestion;
  /** How many fields it filled, for the banner. */
  filled: number;
  fields: ReadonlySet<AutofillField>;
  before: FormValues;
  beforeSuggested: ReadonlySet<AutofillField>;
  /** The first dose's day types just after the fill: they go back with the slot only if still these. */
  dayTypes: readonly string[];
}

interface FormState {
  values: FormValues;
  suggested: ReadonlySet<AutofillField>;
  lookup?: Lookup;
  ai?: AiFill;
}

const without = (set: ReadonlySet<AutofillField>, field: AutofillField) => (set.has(field) ? new Set([...set].filter((f) => f !== field)) : set);

/** Puts back what an AI suggestion filled and the lifter hasn't changed. */
function withoutAiFill(f: FormState): FormState {
  const { ai } = f;
  if (!ai) return f;
  const values = { ...f.values, doses: f.values.doses.map((d) => ({ ...d })) };
  const suggested = new Set(f.suggested);
  const first = values.doses[0];
  const was = ai.before.doses[0];
  for (const field of ai.fields) {
    if (field === 'keyCompound' || field === 'typicalRange' || field === 'timing') values[field] = ai.before[field];
    if (field === 'amount' && first && was) first.amount = was.amount;
    if (field === 'slot' && first && was) {
      first.slot = was.slot;
      if (first.dayTypes.join('\n') === ai.dayTypes.join('\n')) first.dayTypes = was.dayTypes;
    }
    if (ai.beforeSuggested.has(field)) suggested.add(field);
    else suggested.delete(field);
  }
  return { ...f, values, suggested, ai: undefined };
}

/** A field the AI filled gets its tag; a field filled by anything else, SUGGESTED. */
const Suggested = ({ show, ai }: { show: boolean; ai?: boolean }) =>
  ai ? <span className={styles.aiTag}>AI · unverified</span> : show ? <span className={styles.suggestedTag}>SUGGESTED</span> : null;

const TIER_NAME = { catalog: 'the shared catalog', label: 'a product label', ai: 'an AI suggestion' } as const;

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
  const { values, suggested, lookup, ai } = form;
  const setValues = (update: (v: FormValues) => FormValues) => setForm((f) => ({ ...f, values: update(f.values) }));
  const setLookup = (next: Lookup | undefined) => setForm((f) => ({ ...f, lookup: next }));
  // Fields the lifter has typed in; autofill leaves these alone. A replace keeps the replaced
  // item's slot and day types, as if the lifter had chosen them, so a catalog match can't move them.
  const typed = useRef(new Set<string>(replacing ? ['slot'] : []));
  // The items on the stack when the form opened: an item this form adds isn't one to replace.
  const openedWith = useRef(new Set(stack.items.map((i) => i.id)));
  const tryAgainRef = useRef<HTMLButtonElement>(null);
  // Lookups already answered, by name: the catalog doesn't change while the form is open, and nor
  // do product labels. A label outage isn't kept, so the name is asked again.
  const answers = useRef(new Map<string, SupplementCatalogEntry[]>());
  const labelAnswers = useRef(new Map<string, SupplementLabelLookupResponse>());
  const tierRef = useRef<HTMLParagraphElement>(null);
  const [focusTier, setFocusTier] = useState(false);
  // The name as it is now, for an AI answer arriving after the lifter has changed it.
  const latestName = useRef('');
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
    latestName.current = name;
  }, [name]);
  useEffect(() => {
    if (name === '' || name === editingName) {
      setLookup(undefined);
      return;
    }
    let current = true;
    const fill = (entry: SupplementCatalogEntry, found: Pick<Lookup, 'entry' | 'suggested'>) =>
      setForm((f) => {
        const result = autofill(f.values, typed.current, entry, editing ? 'edit' : 'add', stack, dayTypeId);
        return {
          values: result.values,
          lookup: { name, ...found, filled: result.filled.length },
          suggested: new Set([...[...f.suggested].filter((field) => !typed.current.has(field)), ...result.filled]),
          ai: f.ai,
        };
      });
    // Tier 2, after a catalog miss on an add: the NIH label database. A miss, an outage or the
    // lookup limit leaves the form as it is and offers tier 3 (the API logs an outage).
    const labelTier = async (catalogFailed: boolean) => {
      let found = labelAnswers.current.get(name);
      if (!found) {
        try {
          found = await fetchSupplementLabelLookup(name);
        } catch (err) {
          if (!current) return;
          logClientError('supplements.labelLookup', err);
          return setLookup({ name, filled: 0, catalogFailed, label: 'unavailable' });
        }
        if (found.status === 'ready' || found.status === 'none') labelAnswers.current.set(name, found);
      }
      if (!current) return;
      const first = found.status === 'ready' ? found.suggestions[0] : undefined;
      if (first) fill(suggestionEntry(first), { suggested: { tier: 'label', suggestion: first } });
      else if (found.status === 'limited') setLookup({ name, filled: 0, catalogFailed, label: 'limited', retryAfterMinutes: found.retryAfterMinutes });
      else setLookup({ name, filled: 0, catalogFailed, label: found.status === 'none' ? 'none' : 'unavailable' });
    };
    const answered = (entries: SupplementCatalogEntry[]) => {
      if (!current) return;
      const entry = entries[0];
      if (entry) return fill(entry, { entry });
      setLookup({ name, filled: 0 });
      if (!editing) void labelTier(false);
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
          // A failed lookup only means no catalog autofill; the lifter can still fill the form in,
          // and an add goes on to the product label and AI tiers.
          // A lookup the lifter has already typed past isn't worth an error report.
          if (!current) return;
          logClientError('supplements.catalogLookup', err);
          setLookup({ name, filled: 0, catalogFailed: true });
          if (!editing) void labelTier(true);
        },
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [name, editingName, editing, stack, dayTypeId]);

  // The entry matched for the name as it is now; a match for an earlier name is never saved. An AI
  // fill is dropped as soon as the name changes (`withoutAiFill`), so it is always for this name.
  const looked = lookup?.name === name ? lookup : undefined;
  const matched = looked?.entry;
  const aiFilled = ai !== undefined && ai.name === name;
  const suggestedBy = aiFilled ? ai.suggested : looked?.suggested;
  const filledCount = aiFilled ? ai.filled : looked?.filled ?? 0;
  const aiField = (field: AutofillField) => aiFilled && ai.fields.has(field);
  const [aiState, setAiState] = useState<{ name: string; busy: boolean; message?: string } | undefined>();
  const aiBusy = aiState?.name === name && aiState.busy;
  const offerAi = name !== '' && looked?.label !== undefined && !aiFilled;

  // Replace what you already take? (#1411) The item being replaced is always listed first, ticked.
  // The rest are active items sharing an ingredient with what's being added; only same-slot ones
  // it supplies at least as much of start ticked (core's `findOverlaps`), and none when the new
  // item is itself pending, since that would set aside something the lifter takes for something
  // they don't yet. A tick the lifter has changed is kept in `ticks`; every other row follows the
  // rule as the form changes. Only the fields the overlap reads are dependencies, so typing a note
  // doesn't recompute it.
  const { doses, status, protein } = values;
  const candidate = useMemo(() => candidateItem({ doses, status, protein }, matched ?? (suggestedBy && suggestionEntry(suggestedBy.suggestion))), [doses, status, protein, matched, suggestedBy]);
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
        // An unverified AI suggestion never starts out set to replace something the lifter takes.
        on: ticks[o.item.id] ?? (o.preselect && status === 'active' && !aiFilled),
      })),
    ],
    [replacing, candidate, overlaps, ticks, status, dayTypeId, aiFilled],
  );
  // The add went through but dealing with the replaced items didn't: the form can't add again, and
  // `ids` holds only the items still to deal with.
  const [added, setAdded] = useState<{ ids: string[]; how: ReplaceHow } | undefined>();
  useEffect(() => {
    // The form that had focus is gone, so focus the way forward.
    if (added) tryAgainRef.current?.focus();
  }, [added]);

  useEffect(() => {
    if (!focusTier) return;
    setFocusTier(false);
    // The Suggest with AI button the lifter pressed is gone, so focus what it filled in, unless
    // the lifter has moved on to another field while waiting.
    const active = document.activeElement;
    if (!active || active === document.body || !ref.current?.contains(active)) tierRef.current?.focus();
  }, [focusTier]);

  /** Tier 3: asks the AI about the typed name, once tiers 1 and 2 have missed. */
  async function suggestWithAi() {
    if (aiBusy) return;
    const asked = name;
    setAiState({ name: asked, busy: true });
    const done = (message?: string) => setAiState((s) => (s?.name === asked ? { name: asked, busy: false, message } : s));
    try {
      const res = await fetchSupplementAiSuggestion(asked);
      // The lifter changed the name while waiting: the answer is about a name that's gone.
      if (latestName.current !== asked) return done();
      if (res.status === 'ready') {
        setForm((f) => {
          const result = autofill(f.values, typed.current, suggestionEntry(res.suggestion), 'add', stack, dayTypeId);
          // The store-search link row is the app's own suggestion, not the AI's.
          const fields = new Set<AutofillField>(result.filled.filter((field) => field !== 'links'));
          return {
            ...f,
            values: result.values,
            suggested: new Set([...[...f.suggested].filter((field) => !typed.current.has(field) && !fields.has(field)), ...result.filled.filter((field) => !fields.has(field))]),
            ai: {
              name: asked,
              suggested: { tier: 'ai', suggestion: res.suggestion },
              filled: result.filled.length,
              fields,
              before: f.values,
              beforeSuggested: f.suggested,
              dayTypes: result.values.doses[0]?.dayTypes ?? [],
            },
          };
        });
        setFocusTier(true);
        return done();
      }
      done(
        res.status === 'off'
          ? 'AI suggestions aren’t turned on.'
          : res.status === 'limited'
            ? `You’ve used this hour’s AI suggestions; try again in ${res.retryAfterMinutes} minute${res.retryAfterMinutes === 1 ? '' : 's'}.`
            : res.status === 'none'
              ? 'The AI had no suggestion for this name.'
              : 'AI suggestions aren’t available right now.',
      );
    } catch (err) {
      logClientError('supplements.aiSuggestion', err);
      done('AI suggestions aren’t available right now.');
    }
  }

  const typedIn = (field: AutofillField) => {
    typed.current.add(field);
    // A field the lifter changes is theirs: no longer the AI's, and kept if the name changes.
    setForm((f) => ({ ...f, suggested: without(f.suggested, field), ai: f.ai && { ...f.ai, fields: without(f.ai.fields, field) } }));
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
      const body = toBody(values, { item: editing, entry: matched, suggested: suggestedBy });
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
   * from History). Either is one write that changes all of them or none, so a retry sends them all again.
   */
  async function replaceThem(ids: string[], choice: ReplaceHow) {
    setBusy(true);
    setError(undefined);
    try {
      if (choice === 'pending') await setSupplementStatus(ids, 'pending', localToday());
      else await removeSupplementItems(ids, localToday());
      router.refresh();
      const n = `${ids.length} item${ids.length === 1 ? '' : 's'}`;
      onDismiss(`Added ${values.name.trim()}; ${choice === 'pending' ? `moved ${n} to Pending` : `removed ${n}`}.`);
    } catch (err) {
      logClientError('supplements.replaceItems', err, { items: ids.length, how: choice });
      // The add went through, so the page re-reads the stack.
      router.refresh();
      setAdded({ ids, how: choice });
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
            Added {values.name.trim()}, but couldn’t {added.how === 'pending' ? 'move' : 'remove'} the items it replaces. None of them changed; you
            can try again.
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
          {editing?.unverified && <p className={styles.aiBanner}>AI suggestion, not counted until you confirm it in the details.</p>}
          <div className={styles.lookup}>
            <label>
              Name
              <input ref={nameRef} required maxLength={SUPPLEMENT_TEXT_MAX.name} placeholder="e.g. Creatine monohydrate" value={values.name} onChange={(e) => {
                const next = e.target.value;
                // A name away from the one the AI answered for takes back what the AI filled.
                setForm((f) => {
                  const g = f.ai && next.trim() !== f.ai.name ? withoutAiFill(f) : f;
                  return { ...g, values: { ...g.values, name: next, links: trackName(stack, g.values.links, next) } };
                });
              }} />
            </label>
            {/* One live region, always there, so each message added to it is announced. */}
            <div role="status" className={styles.lookupStatus}>
              {matched && filledCount > 0 && (
                <p className={styles.infoBanner}>
                  Filled {filledCount} field{filledCount === 1 ? '' : 's'} from the shared catalog
                  {editing ? '' : '; label facts, uses and sources will be attached'}. Blue fields are suggestions; change anything.
                </p>
              )}
              {suggestedBy && (
                <p ref={tierRef} tabIndex={-1} className={aiFilled ? styles.aiBanner : styles.infoBanner}>
                  Filled {filledCount} field{filledCount === 1 ? '' : 's'} from {TIER_NAME[suggestedBy.tier]}.{' '}
                  {aiFilled
                    ? 'Purple fields are the AI’s. It saves as unverified and isn’t counted in totals until you press Confirm on its detail panel; check it against your label.'
                    : 'Ingredients and amounts will be saved. Check them against your product; change anything.'}
                  {suggestedBy.suggestion.sources.map((s) => (
                    <span key={s.url}>
                      {' '}
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.label}
                      </a>
                    </span>
                  ))}
                </p>
              )}
              {name !== '' && looked && !looked.entry && !suggestedBy && (
                <p className={styles.noMatchBanner}>{looked.catalogFailed ? 'Couldn’t reach the shared catalog.' : 'Not in the shared catalog.'}</p>
              )}
              {offerAi && (
                <p className={styles.noMatchBanner}>
                  {looked.label === 'none'
                    ? `No matching product label${looked.catalogFailed ? '' : ' either'}.`
                    : looked.label === 'limited'
                      ? `Product label lookups are paused for ${looked.retryAfterMinutes ?? 60} minute${looked.retryAfterMinutes === 1 ? '' : 's'}.`
                      : 'The product label database didn’t answer.'}
                </p>
              )}
              {aiState?.name === name && (aiState.busy || aiState.message) && <p className={styles.noMatchBanner}>{aiState.busy ? 'Asking the AI…' : aiState.message}</p>}
            </div>
            {offerAi && (
              <button type="button" className={styles.aiButton} aria-disabled={aiBusy} onClick={() => void suggestWithAi()}>
                Suggest with AI
              </button>
            )}
          </div>

          <label>
            Key compound <Suggested show={suggested.has('keyCompound')} ai={aiField('keyCompound')} />
            <input maxLength={SUPPLEMENT_TEXT_MAX.name} placeholder="e.g. Anthocyanins, 300 mg caffeine" value={values.keyCompound} onChange={(e) => set('keyCompound', e.target.value, 'keyCompound')} />
          </label>

          <fieldset className={styles.doses}>
            <legend>
              When and how much <span className={styles.muted}>(add a row for each time you take it)</span>
            </legend>
            {values.doses.map((d, i) => (
              <div key={i} className={styles.doseRow}>
                <label>
                  Slot <Suggested show={i === 0 && suggested.has('slot')} ai={i === 0 && aiField('slot')} />
                  <select value={d.slot} onChange={(e) => setDose(i, { slot: SUPPLEMENT_SLOTS.find((s) => s === e.target.value) ?? d.slot }, 'slot')}>
                    {SUPPLEMENT_SLOTS.map((s) => (
                      <option key={s} value={s}>
                        {SLOT_OPTION_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Amount <Suggested show={i === 0 && suggested.has('amount')} ai={i === 0 && aiField('amount')} />
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
              Typical range <Suggested show={suggested.has('typicalRange')} ai={aiField('typicalRange')} />
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
            Timing <Suggested show={suggested.has('timing')} ai={aiField('timing')} />
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
