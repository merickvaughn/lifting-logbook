'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { patchLiftMetadata } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import type { LiftMetadataResponse } from '@lifting-logbook/types';
import CatalogTagPicker from './CatalogTagPicker';
import FreeTagPicker from './FreeTagPicker';
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await patchLiftMetadata(initialMetadata.lift, {
        muscleGroups,
        substitutions,
        foundational,
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

      {error && <p className={styles.error}>{error}</p>}

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
