'use client';

import { useState } from 'react';
import { ApiClientError } from '@lifting-logbook/api-client';
import { LIFT_CATALOG } from '@lifting-logbook/core';
import { COMPLEX_LIMITS } from '@lifting-logbook/types';
import type { BarbellComplexResponse, ComplexComponent } from '@lifting-logbook/types';
import { createBarbellComplex, deleteBarbellComplex, updateBarbellComplex } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

/** The complex being written: a new one, or an existing one by id. */
interface Draft {
  id: string | null;
  name: string;
  components: { lift: string; reps: string }[];
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  components: [
    { lift: '', reps: '5' },
    { lift: '', reps: '5' },
  ],
};

function describe(components: readonly ComplexComponent[]): string {
  return components.map((c) => `${c.lift} × ${c.reps}`).join(' → ');
}

/** The draft as a request, or the reason it can't be saved. */
function toRequest(draft: Draft): { name: string; components: ComplexComponent[] } | string {
  const name = draft.name.trim();
  if (name === '') return 'Give the complex a name.';
  const components: ComplexComponent[] = [];
  for (const [i, c] of draft.components.entries()) {
    if (c.lift === '') return `Choose lift ${i + 1}.`;
    const reps = Number(c.reps);
    if (!Number.isInteger(reps) || reps < 1 || reps > COMPLEX_LIMITS.MAX_REPS) {
      return `Reps for lift ${i + 1} must be a whole number from 1 to ${COMPLEX_LIMITS.MAX_REPS}.`;
    }
    components.push({ lift: c.lift, reps });
  }
  return { name, components };
}

/**
 * Create, edit and delete barbell complexes (#1495): a named sequence of lifts done back to back
 * with one bar. A program row can then plan a complex like a lift.
 */
export default function ComplexesEditor({
  initialComplexes,
  customLiftNames,
}: {
  initialComplexes: BarbellComplexResponse[];
  customLiftNames: string[];
}) {
  const [complexes, setComplexes] = useState(initialComplexes);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liftNames = [...LIFT_CATALOG.map((l) => l.name as string), ...customLiftNames];

  function edit(next: Draft | null) {
    setDraft(next);
    setConfirmingDelete(null);
    setError(null);
  }

  function setComponent(index: number, patch: Partial<Draft['components'][number]>) {
    if (!draft) return;
    edit({ ...draft, components: draft.components.map((c, i) => (i === index ? { ...c, ...patch } : c)) });
  }

  async function save() {
    if (!draft) return;
    const body = toRequest(draft);
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = draft.id === null ? await createBarbellComplex(body) : await updateBarbellComplex(draft.id, body);
      if (!result.ok) {
        setError(result.conflictMessage);
        return;
      }
      const saved = result.data;
      setComplexes((list) =>
        draft.id === null ? [...list, saved] : list.map((c) => (c.id === saved.id ? saved : c)),
      );
      setDraft(null);
    } catch (err) {
      logClientError(draft.id === null ? 'createBarbellComplex' : 'updateBarbellComplex', err, {
        ...(draft.id !== null && { complexId: draft.id }),
      });
      setError(
        err instanceof ApiClientError && err.status === 400 ? err.message : 'Couldn’t save the complex. Try again.',
      );
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
    } catch (err) {
      logClientError('deleteBarbellComplex', err, { complexId: complex.id });
      setError('Couldn’t delete the complex. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
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
              <button type="button" disabled={busy} onClick={() => edit({
                id: c.id,
                name: c.name,
                components: c.components.map((x) => ({ lift: x.lift, reps: String(x.reps) })),
              })}>
                Edit {c.name}
              </button>{' '}
              {confirmingDelete === c.id ?
                <>
                  <span>Programs that plan it will show it as deleted.</span>{' '}
                  <button type="button" disabled={busy} onClick={() => remove(c)}>
                    Yes, delete {c.name}
                  </button>{' '}
                  <button type="button" disabled={busy} onClick={() => setConfirmingDelete(null)}>
                    Keep it
                  </button>
                </>
              : <button type="button" disabled={busy} onClick={() => { setConfirmingDelete(c.id); setError(null); }}>
                  Delete {c.name}
                </button>
              }
            </li>
          ))}
        </ul>
      }

      {draft === null ?
        <button type="button" disabled={busy} onClick={() => edit(EMPTY_DRAFT)}>
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
            value={draft.name}
            maxLength={COMPLEX_LIMITS.MAX_NAME_LENGTH}
            onChange={(e) => edit({ ...draft, name: e.target.value })}
          />
          <ol>
            {draft.components.map((c, i) => (
              <li key={i}>
                <select aria-label={`Lift ${i + 1}`} value={c.lift} onChange={(e) => setComponent(i, { lift: e.target.value })}>
                  <option value="" disabled>
                    Choose a lift…
                  </option>
                  {/* A lift no longer offered keeps its name, so editing reps doesn't drop it. */}
                  {c.lift !== '' && !liftNames.includes(c.lift) && <option value={c.lift}>{c.lift}</option>}
                  {liftNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>{' '}
                <input
                  type="number"
                  min={1}
                  max={COMPLEX_LIMITS.MAX_REPS}
                  step={1}
                  aria-label={`Reps ${i + 1}`}
                  value={c.reps}
                  onChange={(e) => setComponent(i, { reps: e.target.value })}
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
            onClick={() => edit({ ...draft, components: [...draft.components, { lift: '', reps: '5' }] })}
          >
            Add lift
          </button>{' '}
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save complex'}
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => edit(null)}>
            Cancel
          </button>
        </form>
      }

      {error && <p role="alert">{error}</p>}
    </section>
  );
}
