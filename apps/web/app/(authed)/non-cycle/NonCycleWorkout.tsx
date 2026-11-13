'use client';

import { useEffect, useId, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { formatNonCycleReference, formatWeight } from '@lifting-logbook/core';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import type { LiftRecordResponse, NonCycleWorkoutResponse, WeightUnit } from '@lifting-logbook/types';
import {
  createLiftRecord,
  createNonCycleWorkout,
  deleteNonCycleWorkout,
  fetchNonCycleReference,
  updateLiftRecord,
} from '@/lib/client-api';
import { localToday } from '@/lib/calendarDay';
import { logClientError } from '@/lib/log-client-error';
import { writeFailureMessage } from '@/lib/macrocycleUrl';
import styles from './NonCycleWorkout.module.css';

interface Props {
  /** The active program, whose training max the reference line shows. */
  program: string;
  /** Lift names to suggest. Any name can be typed. */
  catalog: string[];
  unit: WeightUnit;
  /** The workout being added to; none on a new one, which its first set starts. */
  workout: NonCycleWorkoutResponse | null;
}

/**
 * A non-cycle workout (proposal 2026-11-06, decision 23, #1184): sets done outside any
 * program, each saved as it's entered. Nothing here changes a training max.
 */
export default function NonCycleWorkout({ program, catalog, unit, workout: initial }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const ids = useId();
  const [workout, setWorkout] = useState(initial);
  const [date, setDate] = useState(initial?.date ?? '');
  const [lift, setLift] = useState(initial?.records.at(-1)?.lift ?? '');
  // The lift the reference line is for: set from a catalog name or when the field is left, so
  // a partly typed name isn't looked up.
  const [referenceLift, setReferenceLift] = useState(initial?.records.at(-1)?.lift ?? '');
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The browser knows the lifter's calendar day; the server doesn't.
  useEffect(() => {
    if (!initial) setDate((current) => current || localToday());
  }, [initial]);

  // The first set moves the address to the workout's number without leaving this page (see
  // saveSet). Going back or forward to that address later can restore this page as it was
  // before the first set, with no workout. Only then does a numbered address show no workout,
  // so the page asks the server for the workout's own page.
  useEffect(() => {
    if (!workout && pathname !== '/non-cycle/new') router.refresh();
  }, [workout, pathname, router]);

  // A failed read just leaves the reference line blank.
  useEffect(() => {
    const name = referenceLift.trim();
    setReference('');
    if (!name) return;
    let cancelled = false;
    fetchNonCycleReference(program, name)
      .then(({ reference: ref }) => {
        if (!cancelled && ref) setReference(formatNonCycleReference(ref, unit));
      })
      .catch((err: unknown) => logClientError('fetchNonCycleReference', err, { program }));
    return () => {
      cancelled = true;
    };
  }, [referenceLift, program, unit]);

  function changeLift(value: string) {
    setLift(value);
    const match = catalog.find((name) => name.toLowerCase() === value.trim().toLowerCase());
    if (match) setReferenceLift(value);
  }

  const records = workout?.records ?? [];
  const weightValue = Number(weight);
  const repsValue = Number(reps);
  const canSave =
    !saving && lift.trim() !== '' && date !== '' && weight !== '' && weightValue >= 0 &&
    Number.isInteger(repsValue) && repsValue >= 1;

  async function saveSet(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    const name = lift.trim();
    const setNum = Math.max(0, ...records.filter((r) => r.lift === name).map((r) => r.setNum)) + 1;
    setSaving(true);
    setError(null);
    try {
      if (!workout) {
        const started = await createNonCycleWorkout({ date, lift: name, setNum, weight: weightValue, reps: repsValue });
        setWorkout(started);
        // The workout now has a number. The address follows it without leaving the page, so
        // nothing the lifter is doing here is interrupted.
        window.history.replaceState(null, '', `/non-cycle/${started.workoutNum}`);
      } else {
        const record = await createLiftRecord(
          NON_CYCLE_PROGRAM,
          {
            program: NON_CYCLE_PROGRAM,
            macrocycleNum: 1,
            workoutNum: workout.workoutNum,
            date: workout.date,
            lift: name,
            setNum,
            weight: weightValue,
            reps: repsValue,
          },
          workout.macrocycleId,
        );
        setWorkout((current) => current && { ...current, records: [...current.records, record] });
      }
      setReps('');
    } catch (err) {
      logClientError(workout ? 'createLiftRecord' : 'createNonCycleWorkout', err, {
        program: NON_CYCLE_PROGRAM,
        workoutNum: workout?.workoutNum,
      });
      setError(writeFailureMessage(err, 'Couldn’t save the set. Please try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(record: LiftRecordResponse, changes: { weight: number; reps: number }) {
    if (!workout) return false;
    setError(null);
    try {
      const updated = await updateLiftRecord(NON_CYCLE_PROGRAM, record.id, changes, workout.macrocycleId);
      setWorkout((current) => current && { ...current, records: current.records.map((r) => (r.id === record.id ? updated : r)) });
      return true;
    } catch (err) {
      logClientError('updateLiftRecord', err, { program: NON_CYCLE_PROGRAM, workoutNum: workout.workoutNum });
      setError(writeFailureMessage(err, 'Couldn’t save the change. Please try again.'));
      return false;
    }
  }

  async function deleteWorkout() {
    if (!workout || !window.confirm(`Delete non-cycle workout ${workout.workoutNum} and all its sets?`)) return;
    setError(null);
    try {
      await deleteNonCycleWorkout(workout.workoutNum, workout.macrocycleId);
      router.push('/history');
      router.refresh();
    } catch (err) {
      logClientError('deleteNonCycleWorkout', err, { workoutNum: workout.workoutNum });
      setError(writeFailureMessage(err, 'Couldn’t delete the workout. Please try again.'));
    }
  }

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>
        {workout ? `Non-cycle workout ${workout.workoutNum}` : 'New non-cycle workout'}
      </h1>
      <p className={styles.intro}>
        Training outside your program. These sets are kept in your history and count toward
        PRs, but they never change a training max.
      </p>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <form className={styles.form} onSubmit={(e) => void saveSet(e)}>
        <label className={styles.field}>
          <span>Date</span>
          <input
            type="date"
            value={date}
            max={localToday()}
            onChange={(e) => setDate(e.target.value)}
            disabled={workout !== null}
            required
          />
        </label>
        <label className={styles.field}>
          <span>Lift</span>
          <input
            type="text"
            list={`${ids}-lifts`}
            value={lift}
            onChange={(e) => changeLift(e.target.value)}
            onBlur={() => setReferenceLift(lift)}
            maxLength={100}
            autoComplete="off"
            required
          />
          <datalist id={`${ids}-lifts`}>
            {catalog.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <p className={styles.reference} aria-live="polite">{reference}</p>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Weight (lbs)</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              required
            />
          </label>
          <label className={styles.field}>
            <span>Reps</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={reps}
              onChange={(e) => setReps(e.target.value)}
              required
            />
          </label>
        </div>
        {unit !== 'lbs' && weight !== '' && !Number.isNaN(weightValue) && (
          <p className={styles.hint}>≈ {formatWeight(weightValue, 'lbs', unit)}</p>
        )}
        <button type="submit" className={styles.primary} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save set'}
        </button>
      </form>

      {records.length > 0 && (
        <section aria-labelledby={`${ids}-sets`}>
          <h2 id={`${ids}-sets`} className={styles.subtitle}>Sets on {workout?.date}</h2>
          <ul className={styles.sets}>
            {records.map((record) => (
              <SetRow key={record.id} record={record} unit={unit} onSave={saveEdit} />
            ))}
          </ul>
          <button type="button" className={styles.danger} onClick={() => void deleteWorkout()}>
            Delete workout
          </button>
        </section>
      )}
    </main>
  );
}

function SetRow({
  record,
  unit,
  onSave,
}: {
  record: LiftRecordResponse;
  unit: WeightUnit;
  onSave: (record: LiftRecordResponse, changes: { weight: number; reps: number }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const label = `${record.lift} set ${record.setNum}`;

  // Each edit starts from the stored set, not from an edit left unsaved.
  function startEditing() {
    setWeight(String(record.weight));
    setReps(String(record.reps));
    setEditing(true);
  }

  if (!editing) {
    return (
      <li className={styles.set}>
        <span>
          {label}: {formatWeight(record.weight, 'lbs', unit)} × {record.reps}
        </span>
        <button type="button" className={styles.secondary} onClick={startEditing} aria-label={`Edit ${label}`}>
          Edit
        </button>
      </li>
    );
  }

  const weightValue = Number(weight);
  const repsValue = Number(reps);
  const valid = weight !== '' && weightValue >= 0 && Number.isInteger(repsValue) && repsValue >= 1;
  return (
    <li className={styles.set}>
      <form
        className={styles.editForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || saving) return;
          setSaving(true);
          void onSave(record, { weight: weightValue, reps: repsValue }).then((saved) => {
            setSaving(false);
            if (saved) setEditing(false);
          });
        }}
      >
        <span>{label}</span>
        <label className={styles.field}>
          <span>Weight (lbs)</span>
          <input type="number" min={0} step="any" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Reps</span>
          <input type="number" min={1} step={1} value={reps} onChange={(e) => setReps(e.target.value)} />
        </label>
        <button type="submit" className={styles.primary} disabled={!valid || saving}>Save</button>
        <button type="button" className={styles.secondary} onClick={() => setEditing(false)}>Cancel</button>
      </form>
    </li>
  );
}
