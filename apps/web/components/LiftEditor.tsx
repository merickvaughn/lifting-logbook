'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { patchLiftMetadata } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { EMPTY_PROGRESSION_DRAFT, parseProgressionDraft, progressionDraft } from '@/lib/progression';
import type { LiftMetadataResponse } from '@lifting-logbook/types';
import CatalogTagPicker from './CatalogTagPicker';
import FreeTagPicker from './FreeTagPicker';
import ProgressionFields from './ProgressionFields';
import styles from './LiftEditor.module.css';

interface Props {
  macrocycleNum: number;
  workoutNum: number;
  initialMetadata: LiftMetadataResponse;
}

export default function LiftEditor({ macrocycleNum, workoutNum, initialMetadata }: Props) {
  const router = useRouter();
  const [muscleGroups, setMuscleGroups] = useState<string[]>(initialMetadata.muscleGroups);
  const [substitutions, setSubstitutions] = useState<string[]>(initialMetadata.substitutions);
  const [foundational, setFoundational] = useState(initialMetadata.foundational);
  const [progression, setProgression] = useState(() =>
    progressionDraft({
      type: initialMetadata.progression,
      increment: initialMetadata.progressionIncrement,
      repsLow: initialMetadata.repsLow,
      repsHigh: initialMetadata.repsHigh,
    }),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const parsed = parseProgressionDraft(progression);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await patchLiftMetadata(initialMetadata.lift, {
        muscleGroups,
        substitutions,
        foundational,
        progression: parsed.values.type,
        progressionIncrement: parsed.values.increment,
        repsLow: parsed.values.repsLow,
        repsHigh: parsed.values.repsHigh,
      });
      router.refresh();
      router.push(
        `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts`,
      );
    } catch (err) {
      logClientError('patchLiftMetadata', err, { lift: initialMetadata.lift });
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setMuscleGroups([]);
    setSubstitutions([]);
    setFoundational(false);
    setProgression(EMPTY_PROGRESSION_DRAFT);
  }

  return (
    <div className={styles.container}>
      <div className={styles.field}>
        <span className={styles.label}>Lift</span>
        <p className={styles.readOnly}>{initialMetadata.lift}</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="muscleGroups">
          Muscle Groups
        </label>
        <FreeTagPicker
          id="muscleGroups"
          value={muscleGroups}
          onChange={setMuscleGroups}
          placeholder="e.g. Quads, Glutes, Hamstrings"
          disabled={saving}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="substitutions">
          Substitutions
        </label>
        <CatalogTagPicker
          id="substitutions"
          value={substitutions}
          onChange={setSubstitutions}
          disabled={saving}
        />
      </div>

      <div className={styles.checkboxField}>
        <input
          id="foundational"
          type="checkbox"
          checked={foundational}
          onChange={(e) => setFoundational(e.target.checked)}
          disabled={saving}
        />
        <label className={styles.label} htmlFor="foundational">
          Foundational lift
        </label>
      </div>

      <ProgressionFields
        idPrefix="lift-progression"
        label="Progression"
        unsetLabel="Use my default progression"
        value={progression}
        onChange={setProgression}
        disabled={saving}
        classNames={{ field: styles.field, label: styles.label, input: styles.input }}
      />
      <p className={styles.hint}>
        How this lift&apos;s training max moves. A program row that sets its own progression still
        wins inside that program; every built-in program does.
      </p>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={handleReset}
          disabled={saving}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
