'use client';

import { useState } from 'react';
import { complexSetKey, formatWeight } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import { ComplexSummary } from '@/components/complex/ComplexPlanView';
import { createLiftRecord, deleteLiftRecord } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { followMovedMacrocycle, writeFailureMessage } from '@/lib/macrocycleUrl';
import type { ComplexSlot, LoggedComplexSet } from './types';
import styles from './WorkoutLogger.module.css';

/** A round added but not saved yet: its number, fixed when added, and each component's reps. */
interface PendingRound {
  round: number;
  reps: string[];
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

  const rounds = byRound(logged);
  const nextRound = Math.max(0, ...rounds.map(([round]) => round), ...pending.map((p) => p.round)) + 1;
  // Each round takes a set number per lift; a complex has room for as many as the numbers allow.
  const canAddRound = complexSetKey(ordinal, nextRound, components.length - 1, components.length) !== undefined;

  function addRound() {
    setError(null);
    setPending((list) => [...list, { round: nextRound, reps: components.map((c) => String(c.reps)) }]);
  }

  function setReps(round: number, component: number, value: string) {
    setPending((list) =>
      list.map((p) => (p.round === round ? { ...p, reps: p.reps.map((r, j) => (j === component ? value : r)) } : p)),
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
    // Round by round, so a failure leaves the rounds not yet saved to save again. A retry resends a
    // round's saved sets too, which the API answers with the set it already has.
    for (const p of pending) {
      const saved: LoggedComplexSet[] = [];
      for (const [j, component] of components.entries()) {
        const key = complexSetKey(ordinal, p.round, j, components.length);
        if (!key) break;
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
          saved.push({ id: record.id, setNum: key.setNum, weight: load, reps, lift: component.lift, complexRound: p.round });
        } catch (err) {
          logClientError('createLiftRecord', err, { program, macrocycleNum, workoutNum, complex: name, round: p.round });
          if (followMovedMacrocycle(err)) return;
          setLogged((list) => [...list.filter((s) => !saved.some((x) => x.id === s.id)), ...saved]);
          setError(writeFailureMessage(err, `Failed to save round ${p.round}. Try again.`));
          setBusy(false);
          return;
        }
      }
      setLogged((list) => [...list.filter((s) => !saved.some((x) => x.id === s.id)), ...saved]);
      setPending((list) => list.filter((x) => x.round !== p.round));
    }
    setBusy(false);
  }

  async function removeRound(round: number, sets: readonly LoggedComplexSet[]) {
    setBusy(true);
    setError(null);
    for (const set of sets) {
      try {
        await deleteLiftRecord(program, set.id, macrocycleId);
        setLogged((list) => list.filter((s) => s.id !== set.id));
      } catch (err) {
        logClientError('deleteLiftRecord', err, { program, id: set.id, complex: name, round });
        if (followMovedMacrocycle(err)) return;
        setError(writeFailureMessage(err, `Failed to remove round ${round}. Try again.`));
        setBusy(false);
        return;
      }
    }
    setBusy(false);
  }

  const nameOf = (lift: string) => components.find((c) => c.lift === lift)?.name ?? lift;

  return (
    <section className={styles.complexCard} aria-labelledby={`complex-${ordinal}-heading`}>
      <h3 id={`complex-${ordinal}-heading`} className={styles.complexName}>
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
              aria-label={`${name} weight in lbs`}
              value={weight}
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
                    onChange={(e) => setReps(p.round, j, e.target.value)}
                  />
                </label>
              ))}
              <button
                type="button"
                className={styles.cancelBtn}
                disabled={busy}
                aria-label={`Discard ${name} round ${p.round}`}
                onClick={() => setPending((list) => list.filter((x) => x.round !== p.round))}
              >
                Discard
              </button>
            </fieldset>
          ))}

          <button type="button" className={styles.editBtn} disabled={busy || !canAddRound} onClick={addRound}>
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
        </>
      )}
    </section>
  );
}
