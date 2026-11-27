'use client';

import { useEffect, useRef, useState } from 'react';
import { complexSetKey, formatWeight } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import { ComplexSummary } from '@/components/complex/ComplexPlanView';
import { createLiftRecord, deleteLiftRecord } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { followMovedMacrocycle, writeFailureMessage } from '@/lib/macrocycleUrl';
import type { ComplexSlot, LoggedComplexSet } from './types';
import styles from './WorkoutLogger.module.css';

/**
 * A round added but not saved yet: its number, fixed when added, each component's reps, and the
 * id of each component's set once saved. A round a failure stopped part way keeps its saved
 * sets' ids, so saving again sends only the rest.
 */
interface PendingRound {
  round: number;
  reps: string[];
  saved: (string | undefined)[];
}

/** The logged sets by round, in order. */
function byRound(logged: readonly LoggedComplexSet[]): [number, LoggedComplexSet[]][] {
  const rounds = new Map<number, LoggedComplexSet[]>();
  for (const set of logged) rounds.set(set.complexRound, [...(rounds.get(set.complexRound) ?? []), set]);
  return [...rounds].sort(([a], [b]) => a - b).map(([round, sets]) => [round, sets.sort((a, b) => a.setNum - b.setNum)]);
}

/**
 * Logs one complex slot (#1496): one weight for the whole complex, then a round per tap, each
 * listing every lift with its reps from the definition, which can be changed before saving.
 * **Save rounds** writes one set per lift per round, tagged with the complex's name and the round,
 * where `complexSetKey` places it, clear of the lifts' own sets. Removing a logged round deletes
 * its sets. Weights are entered in lbs, as every logged set's are.
 */
export default function ComplexCard({
  slot,
  program,
  macrocycleNum,
  macrocycleId,
  workoutNum,
  date,
  unit,
}: {
  slot: ComplexSlot;
  program: string;
  macrocycleNum: number;
  macrocycleId?: string;
  workoutNum: number;
  date: string;
  unit: WeightUnit;
}) {
  const { complex, tm, workWeights, ordinal } = slot;
  const { name, components } = complex;
  const [logged, setLogged] = useState(slot.logged);
  const [pending, setPending] = useState<PendingRound[]>([]);
  const [weight, setWeight] = useState(() => {
    const start = slot.logged[0]?.weight ?? workWeights[0];
    return start === undefined ? '' : String(start);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the last save, discard or removal did, for screen readers; and a request to move focus
  // off the button it took away.
  const [status, setStatus] = useState('');
  const [refocus, setRefocus] = useState(0);
  const addRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const rounds = byRound(logged);
  const nextRound = Math.max(0, ...rounds.map(([round]) => round), ...pending.map((p) => p.round)) + 1;
  // Each round takes a set number per lift; a complex has room for as many as the numbers allow.
  const canAddRound = complexSetKey(ordinal, nextRound, components.length - 1, components.length) !== undefined;
  // A round saved part way is at one weight, so the weight holds until the round is done.
  const weightLocked = pending.some((p) => p.saved.some((id) => id !== undefined));

  useEffect(() => {
    if (refocus === 0) return;
    const add = addRef.current;
    if (add && !add.disabled) add.focus();
    else headingRef.current?.focus();
  }, [refocus]);

  function addRound() {
    setError(null);
    setPending((list) => [
      ...list,
      { round: nextRound, reps: components.map((c) => String(c.reps)), saved: components.map(() => undefined) },
    ]);
  }

  function setReps(round: number, component: number, value: string) {
    setPending((list) =>
      list.map((p) => (p.round === round ? { ...p, reps: p.reps.map((r, j) => (j === component ? value : r)) } : p)),
    );
  }

  function markSaved(round: number, component: number, id: string) {
    setPending((list) =>
      list.map((p) => (p.round === round ? { ...p, saved: p.saved.map((s, j) => (j === component ? id : s)) } : p)),
    );
  }

  async function save() {
    const load = Number(weight);
    if (weight.trim() === '' || !Number.isFinite(load) || load < 0) {
      setError('Enter the weight, in lbs.');
      return;
    }
    if (pending.some((p) => p.reps.some((r) => !Number.isInteger(Number(r)) || Number(r) < 1 || r.trim() === ''))) {
      setError('Each lift’s reps must be a whole number from 1.');
      return;
    }
    setBusy(true);
    setError(null);
    setStatus('');
    const done: number[] = [];
    // Round by round, so a failure leaves the rounds not yet saved to save again. A component
    // already saved isn't sent again.
    for (const p of pending) {
      for (const [j, component] of components.entries()) {
        const key = complexSetKey(ordinal, p.round, j, components.length);
        if (!key || p.saved[j] !== undefined) continue;
        const reps = Number(p.reps[j]);
        try {
          const record = await createLiftRecord(
            program,
            {
              program,
              macrocycleNum,
              workoutNum,
              date,
              lift: component.lift,
              occurrence: key.occurrence,
              setNum: key.setNum,
              weight: load,
              reps,
              complex: name,
              complexRound: p.round,
            },
            macrocycleId,
          );
          const set = { id: record.id, setNum: key.setNum, weight: load, reps, lift: component.lift, complexRound: p.round };
          setLogged((list) => [...list.filter((s) => s.id !== set.id), set]);
          markSaved(p.round, j, record.id);
        } catch (err) {
          logClientError('createLiftRecord', err, { program, macrocycleNum, workoutNum, complex: name, round: p.round });
          if (followMovedMacrocycle(err)) return;
          setPending((list) => list.filter((x) => !done.includes(x.round)));
          setError(writeFailureMessage(err, `Failed to save round ${p.round}. Try again.`));
          setBusy(false);
          return;
        }
      }
      done.push(p.round);
    }
    setPending((list) => list.filter((x) => !done.includes(x.round)));
    setStatus(done.length === 1 ? `Saved round ${done[0]}.` : `Saved ${done.length} rounds.`);
    setBusy(false);
    setRefocus((n) => n + 1);
  }

  function discardRound(round: number) {
    setPending((list) => list.filter((x) => x.round !== round));
    setStatus(`Discarded round ${round}.`);
    setRefocus((n) => n + 1);
  }

  async function removeRound(round: number, sets: readonly LoggedComplexSet[]) {
    setBusy(true);
    setError(null);
    setStatus('');
    for (const set of sets) {
      try {
        await deleteLiftRecord(program, set.id, macrocycleId);
        setLogged((list) => list.filter((s) => s.id !== set.id));
        // A round saved part way sends this set again if it's saved again.
        setPending((list) => list.map((p) => ({ ...p, saved: p.saved.map((id) => (id === set.id ? undefined : id)) })));
      } catch (err) {
        logClientError('deleteLiftRecord', err, { program, id: set.id, complex: name, round });
        if (followMovedMacrocycle(err)) return;
        setError(writeFailureMessage(err, `Failed to remove round ${round}. Try again.`));
        setBusy(false);
        return;
      }
    }
    setStatus(`Removed round ${round}.`);
    setBusy(false);
    setRefocus((n) => n + 1);
  }

  const nameOf = (lift: string) => components.find((c) => c.lift === lift)?.name ?? lift;

  return (
    <section className={styles.complexCard} aria-labelledby={`complex-${ordinal}-heading`}>
      <h3 id={`complex-${ordinal}-heading`} className={styles.complexName} ref={headingRef} tabIndex={-1}>
        {name}
      </h3>
      <ComplexSummary complex={complex} tm={tm} unit={unit} />
      {workWeights.length > 0 && (
        <p className={styles.complexNote}>
          Working sets at {workWeights.map((w) => formatWeight(w, 'lbs', unit)).join(', ')}
        </p>
      )}
      {complex.missing.length > 0 && (
        <p className={styles.complexNote}>Needs a training max for {complex.missing.map((m) => m.name).join(', ')}.</p>
      )}

      {complex.found && (
        <>
          <label className={styles.complexNote}>
            Weight (lbs){' '}
            <input
              className={styles.setInput}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              aria-label={`Weight (lbs) for ${name}`}
              value={weight}
              disabled={weightLocked}
              onChange={(e) => setWeight(e.target.value)}
            />
          </label>

          {rounds.length > 0 && (
            <ol className={styles.setList} aria-label={`${name} logged rounds`}>
              {rounds.map(([round, sets]) => (
                <li key={round} className={styles.setRowLogged}>
                  <span className={styles.setSummary}>
                    Round {round}: {sets.map((s) => `${nameOf(s.lift)} × ${s.reps}`).join(', ')} at{' '}
                    {formatWeight(sets[0]?.weight ?? 0, 'lbs', unit)}
                  </span>{' '}
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    disabled={busy}
                    aria-label={`Remove ${name} round ${round}`}
                    onClick={() => void removeRound(round, sets)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          )}

          {pending.map((p) => (
            <fieldset key={p.round} className={styles.setForm}>
              <legend>Round {p.round}</legend>
              {components.map((c, j) => (
                <label key={j} className={styles.complexNote}>
                  {c.name}{' '}
                  <input
                    className={styles.setInput}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    aria-label={`${name} round ${p.round} ${c.name} reps`}
                    value={p.reps[j] ?? ''}
                    disabled={p.saved[j] !== undefined}
                    onChange={(e) => setReps(p.round, j, e.target.value)}
                  />
                </label>
              ))}
              <button
                type="button"
                className={styles.cancelBtn}
                disabled={busy}
                aria-label={`Discard ${name} round ${p.round}`}
                onClick={() => discardRound(p.round)}
              >
                Discard
              </button>
            </fieldset>
          ))}

          <button
            type="button"
            ref={addRef}
            className={styles.editBtn}
            disabled={busy || !canAddRound}
            onClick={addRound}
          >
            Add a round of {name}
          </button>{' '}
          {pending.length > 0 && (
            <button type="button" className={styles.logBtn} disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : `Save ${name} rounds`}
            </button>
          )}
          {error && (
            <p className={styles.setError} role="alert">
              {error}
            </p>
          )}
          <p className={styles.srOnly} role="status">
            {status}
          </p>
        </>
      )}
    </section>
  );
}
