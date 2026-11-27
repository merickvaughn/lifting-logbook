'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ApiClientError } from '@lifting-logbook/api-client';
import { LIFT_CATALOG, lookupLift } from '@lifting-logbook/core';
import { COMPLEX_LIMITS } from '@lifting-logbook/types';
import type { BarbellComplexResponse, ComplexComponent, ComplexComponentResponse } from '@lifting-logbook/types';
import { createBarbellComplex, deleteBarbellComplex, updateBarbellComplex } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

/** A custom lift as the editor offers it: stored by id, shown by name. */
export interface ComplexLiftOption {
  id: string;
  name: string;
}

/** The complex being written: a new one, or an existing one by id. */
interface Draft {
  id: string | null;
  name: string;
  /** `lift` as stored: a catalog lift's name or a custom lift's id. `name` is what the API showed. */
  components: { lift: string; name: string; reps: string }[];
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  components: [
    { lift: '', name: '', reps: '5' },
    { lift: '', name: '', reps: '5' },
  ],
};

/** The field a refusal is about, so it can be marked invalid and point at the message. */
type Field = 'name' | `lift-${number}` | `reps-${number}`;

function describe(components: readonly ComplexComponentResponse[]): string {
  return components.map((c) => `${c.name} × ${c.reps}`).join(' → ');
}

/** The draft as a request, or what to fix and where. */
function toRequest(draft: Draft): { name: string; components: ComplexComponent[] } | { message: string; field: Field } {
  const name = draft.name.trim();
  if (name === '') return { message: 'Give the complex a name.', field: 'name' };
  const components: ComplexComponent[] = [];
  for (const [i, c] of draft.components.entries()) {
    if (c.lift === '') return { message: `Choose lift ${i + 1}.`, field: `lift-${i}` };
    const reps = Number(c.reps);
    if (!Number.isInteger(reps) || reps < 1 || reps > COMPLEX_LIMITS.MAX_REPS) {
      return {
        message: `Reps for lift ${i + 1} must be a whole number from 1 to ${COMPLEX_LIMITS.MAX_REPS}.`,
        field: `reps-${i}`,
      };
    }
    components.push({ lift: c.lift, reps });
  }
  return { name, components };
}

/**
 * Create, edit and delete barbell complexes (#1495): a named sequence of lifts done back to back
 * with one bar. A program row can then plan a complex like a lift.
 *
 * Focus is moved by hand wherever a control it was on goes away: to the confirm button when Delete
 * asks, to the name when the form opens, and back to **New complex** when the form closes or a
 * complex is deleted.
 */
export default function ComplexesEditor({
  initialComplexes,
  customLifts,
}: {
  initialComplexes: BarbellComplexResponse[];
  customLifts: ComplexLiftOption[];
}) {
  const [complexes, setComplexes] = useState(initialComplexes);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: Field } | null>(null);
  // Where focus goes once the next render has put the target on the page.
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (focusTarget === null) return;
    const targets = root.current?.querySelectorAll<HTMLElement>('[data-focus]') ?? [];
    Array.from(targets).find((el) => el.dataset.focus === focusTarget)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const options = [
    ...LIFT_CATALOG.map((l) => ({ value: l.name as string, label: l.name as string })),
    ...customLifts.map((l) => ({ value: l.id, label: l.name })),
  ];
  /** A stored lift that is no longer a lift: its custom lift was deleted. */
  const isStale = (lift: string) => {
    const { builtIn, custom } = lookupLift(lift, customLifts);
    return builtIn === undefined && custom === undefined;
  };

  function edit(next: Draft | null) {
    setDraft(next);
    setConfirmingDelete(null);
    setError(null);
  }

  function close() {
    edit(null);
    setFocusTarget('new');
  }

  function open(next: Draft) {
    edit(next);
    setFocusTarget('name');
  }

  function setComponent(index: number, patch: Partial<Draft['components'][number]>) {
    if (!draft) return;
    edit({ ...draft, components: draft.components.map((c, i) => (i === index ? { ...c, ...patch } : c)) });
  }

  /** Props tying a field to the message about it. */
  const invalidProps = (field: Field) =>
    error?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};

  async function save() {
    if (!draft) return;
    const body = toRequest(draft);
    if ('message' in body) {
      setError(body);
      setFocusTarget(body.field);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = draft.id === null ? await createBarbellComplex(body) : await updateBarbellComplex(draft.id, body);
      if (!result.ok) {
        setError({ message: result.conflictMessage, field: 'name' });
        setFocusTarget('name');
        return;
      }
      const saved = result.data;
      setComplexes((list) =>
        draft.id === null ? [...list, saved] : list.map((c) => (c.id === saved.id ? saved : c)),
      );
      close();
    } catch (err) {
      logClientError(draft.id === null ? 'createBarbellComplex' : 'updateBarbellComplex', err, {
        ...(draft.id !== null && { complexId: draft.id }),
      });
      setError({
        message:
          err instanceof ApiClientError && err.status === 400 ? err.message : 'Couldn’t save the complex. Try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(complex: BarbellComplexResponse) {
    setBusy(true);
    setError(null);
    try {
      await deleteBarbellComplex(complex.id);
      setComplexes((list) => list.filter((c) => c.id !== complex.id));
      setConfirmingDelete(null);
      setFocusTarget('new');
    } catch (err) {
      logClientError('deleteBarbellComplex', err, { complexId: complex.id });
      setError({ message: 'Couldn’t delete the complex. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section ref={root}>
      <h2>Complexes</h2>
      <p>
        A complex is a run of lifts done back to back with one bar, such as a Bear. Add one to a
        program day from the Programs editor; it is planned from the lowest training max among its
        lifts.
      </p>

      {complexes.length === 0 ?
        <p>No complexes yet.</p>
      : <ul aria-label="Your complexes">
          {complexes.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong> <span>{describe(c.components)}</span>{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  open({
                    id: c.id,
                    name: c.name,
                    components: c.components.map((x) => ({ lift: x.lift, name: x.name, reps: String(x.reps) })),
                  })
                }
              >
                Edit {c.name}
              </button>{' '}
              {confirmingDelete === c.id ?
                <>
                  <span>Programs that plan it will show it as deleted.</span>{' '}
                  <button type="button" data-focus="confirm" disabled={busy} onClick={() => remove(c)}>
                    Yes, delete {c.name}
                  </button>{' '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirmingDelete(null);
                      setFocusTarget(`delete-${c.id}`);
                    }}
                  >
                    Keep it
                  </button>
                </>
              : <button
                  type="button"
                  data-focus={`delete-${c.id}`}
                  disabled={busy}
                  onClick={() => {
                    setConfirmingDelete(c.id);
                    setError(null);
                    setFocusTarget('confirm');
                  }}
                >
                  Delete {c.name}
                </button>
              }
            </li>
          ))}
        </ul>
      }

      {draft === null ?
        <button type="button" data-focus="new" disabled={busy} onClick={() => open(EMPTY_DRAFT)}>
          New complex
        </button>
      : <form
          aria-label={draft.id === null ? 'New complex' : 'Edit complex'}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor="complex-name">Complex name</label>
          <input
            id="complex-name"
            data-focus="name"
            value={draft.name}
            maxLength={COMPLEX_LIMITS.MAX_NAME_LENGTH}
            onChange={(e) => edit({ ...draft, name: e.target.value })}
            {...invalidProps('name')}
          />
          <ol>
            {draft.components.map((c, i) => (
              <li key={i}>
                <select
                  aria-label={`Lift ${i + 1}`}
                  data-focus={`lift-${i}`}
                  value={c.lift}
                  onChange={(e) => setComponent(i, { lift: e.target.value })}
                  {...invalidProps(`lift-${i}`)}
                >
                  <option value="" disabled>
                    Choose a lift…
                  </option>
                  {/* A stored lift not offered (a deleted custom lift, another spelling) is kept. */}
                  {c.lift !== '' && !options.some((o) => o.value === c.lift) && (
                    <option value={c.lift}>{isStale(c.lift) ? `${c.name} (no longer a lift)` : c.name}</option>
                  )}
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>{' '}
                <input
                  type="number"
                  min={1}
                  max={COMPLEX_LIMITS.MAX_REPS}
                  step={1}
                  aria-label={`Reps ${i + 1}`}
                  data-focus={`reps-${i}`}
                  value={c.reps}
                  onChange={(e) => setComponent(i, { reps: e.target.value })}
                  {...invalidProps(`reps-${i}`)}
                />{' '}
                <button
                  type="button"
                  aria-label={`Remove lift ${i + 1}`}
                  disabled={draft.components.length <= COMPLEX_LIMITS.MIN_COMPONENTS}
                  onClick={() => edit({ ...draft, components: draft.components.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={draft.components.length >= COMPLEX_LIMITS.MAX_COMPONENTS}
            onClick={() =>
              edit({ ...draft, components: [...draft.components, { lift: '', name: '', reps: '5' }] })
            }
          >
            Add lift
          </button>{' '}
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save complex'}
          </button>{' '}
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </form>
      }

      {error && (
        <p id={errorId} role="alert">
          {error.message}
        </p>
      )}
    </section>
  );
}
