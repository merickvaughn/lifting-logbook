'use client';

import { useEffect, useState } from 'react';
import { ApiClientError } from '@lifting-logbook/api-client';
import type {
  LiftModificationMaxMode,
  LiftModificationResponse,
  UpdateLiftModificationRequest,
} from '@lifting-logbook/types';
import {
  fetchLiftModifications,
  fetchModificationMaxes,
  putModificationMax,
  updateLiftModification,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './LiftEditor.module.css';

const MAX_MODES: { value: LiftModificationMaxMode; label: string }[] = [
  { value: 'none', label: "Plans from the lift's max and moves no max" },
  { value: 'lift', label: "Plans from and moves the lift's max" },
  { value: 'own', label: 'Plans from and moves its own max' },
];

interface Props {
  program: string;
  /** The lift's name, as the logger reads its modifications. */
  lift: string;
}

/**
 * A lift's modifications, each editable: its name, description, which max it plans from and
 * moves, and, for one with its own, that max in this program (#1153). Adding one stays in the
 * logger, where a variation comes up; removing one is out of scope here.
 */
export default function LiftModificationsEditor({ program, lift }: Props) {
  // `null` while loading; 'failed' when either read failed, since a blank max field could
  // otherwise read as "no max yet" and invite overwriting one.
  const [loaded, setLoaded] = useState<
    { modifications: LiftModificationResponse[]; maxes: Record<string, number> } | 'failed' | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchLiftModifications(lift), fetchModificationMaxes(program)]).then(
      ([modifications, maxes]) => {
        if (!cancelled) {
          setLoaded({ modifications, maxes: Object.fromEntries(maxes.map((m) => [m.modificationId, m.weight])) });
        }
      },
      // fallback-covered-by: apps/web/components/LiftModificationsEditor.test.tsx
      (err: unknown) => {
        logClientError('fetchLiftModifications', err, { program, lift });
        if (!cancelled) setLoaded('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [program, lift]);

  return (
    <section className={styles.container} aria-labelledby="lift-modifications-heading">
      <h2 id="lift-modifications-heading" className={styles.label}>
        Modifications
      </h2>
      {loaded === 'failed' && (
        <p className={styles.error} role="status">
          Modifications didn&apos;t load. Reload to try again.
        </p>
      )}
      {loaded !== null && loaded !== 'failed' && loaded.modifications.length === 0 && (
        <p className={styles.hint}>No modifications yet. Add one from the workout logger.</p>
      )}
      {loaded !== null &&
        loaded !== 'failed' &&
        loaded.modifications.map((m) => (
          <ModificationRow key={m.id} program={program} lift={lift} initial={m} initialMax={loaded.maxes[m.id]} />
        ))}
    </section>
  );
}

function ModificationRow({
  program,
  lift,
  initial,
  initialMax,
}: {
  program: string;
  lift: string;
  initial: LiftModificationResponse;
  initialMax: number | undefined;
}) {
  const [saved, setSaved] = useState(initial);
  const [savedMax, setSavedMax] = useState(initialMax);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [maxMode, setMaxMode] = useState(initial.maxMode);
  const [maxInput, setMaxInput] = useState(initialMax === undefined ? '' : String(initialMax));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const id = `modification-${initial.id}`;

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name.');
      return;
    }
    // An empty field leaves the max as it is: none yet, until a set logged with it starts one.
    const weight = maxMode === 'own' && maxInput.trim() !== '' ? Number(maxInput) : undefined;
    if (weight !== undefined && !(weight > 0)) {
      setError('Enter a max above 0.');
      return;
    }
    const changes: UpdateLiftModificationRequest = {
      ...(trimmed !== saved.name && { name: trimmed }),
      ...(description !== saved.description && { description }),
      ...(maxMode !== saved.maxMode && { maxMode }),
    };
    setSaving(true);
    setError(null);
    setDone(false);
    // The mode goes first: the API takes a max only for a modification that has its own.
    let op = 'updateLiftModification';
    try {
      if (Object.keys(changes).length > 0) {
        const res = await updateLiftModification(saved.id, changes);
        if (!res.ok) {
          setError(res.conflictMessage);
          return;
        }
        setSaved(res.data);
      }
      if (weight !== undefined && weight !== savedMax) {
        op = 'putModificationMax';
        setSavedMax((await putModificationMax(program, saved.id, { weight })).weight);
      }
      setDone(true);
    } catch (err) {
      logClientError(
        op,
        err,
        op === 'putModificationMax' ? { program, modificationId: saved.id } : { modificationId: saved.id },
      );
      setError(
        err instanceof ApiClientError && err.status === 400 ? err.message : 'Failed to save. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className={styles.container} disabled={saving}>
      <legend className={styles.readOnly}>{saved.name}</legend>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-description`}>
          Description
        </label>
        <input
          id={`${id}-description`}
          className={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-max-mode`}>
          Max
        </label>
        <select
          id={`${id}-max-mode`}
          className={styles.input}
          value={maxMode}
          onChange={(e) => setMaxMode(e.target.value as LiftModificationMaxMode)}
        >
          {MAX_MODES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {maxMode === 'own' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-max`}>
            Own max (lbs)
          </label>
          <input
            id={`${id}-max`}
            className={styles.input}
            type="number"
            min="0"
            step="2.5"
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
          />
          {savedMax === undefined && (
            <p className={styles.hint}>No max yet: sets plan from {lift}&apos;s until one is entered or logged.</p>
          )}
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {done && <p className={styles.hint}>Saved.</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.btnSecondary} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </fieldset>
  );
}
