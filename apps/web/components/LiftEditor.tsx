'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { patchLiftMetadata } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { EMPTY_PROGRESSION_DRAFT, parseProgressionDraft, progressionDraft } from '@/lib/progression';
import { canonicalMuscleGroup, type ResolvedMuscleTargets } from '@lifting-logbook/core';
import { MUSCLE_GROUPS, type LiftMetadataResponse, type MuscleTargets } from '@lifting-logbook/types';
import CatalogTagPicker from './CatalogTagPicker';
import LiftModificationsEditor from './LiftModificationsEditor';
import ProgressionFields from './ProgressionFields';
import styles from './LiftEditor.module.css';

interface Props {
  /** The active program, whose own maxes the modifications section edits (#1153). */
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  initialMetadata: LiftMetadataResponse;
  /** The lift's effective muscles, resolved over all of the user's rows (#1017). */
  muscles: ResolvedMuscleTargets;
  /** The built-in defaults for the lift's name, or null when it has none. */
  defaultMuscles: MuscleTargets | null;
}

const NO_MUSCLES: MuscleTargets = { primary: [], secondary: [] };

/** Equal as sets of muscles, ignoring case and order, as the resolver reads them. */
function sameMuscles(a: readonly string[], b: readonly string[]): boolean {
  const key = (list: readonly string[]) =>
    [...new Set(list.map((m) => canonicalMuscleGroup(m).toLowerCase()).filter(Boolean))].sort().join('|');
  return key(a) === key(b);
}

export default function LiftEditor({
  program,
  macrocycleNum,
  workoutNum,
  initialMetadata,
  muscles,
  defaultMuscles,
}: Props) {
  const router = useRouter();
  const defaults = defaultMuscles ?? NO_MUSCLES;
  const [primary, setPrimary] = useState<string[]>([...muscles.primary]);
  const [secondary, setSecondary] = useState<string[]>([...muscles.secondary]);
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

  // Both lists empty is how a row says "use the defaults", so lists equal to the defaults are
  // saved that way: the lift then follows any later change to them (ADR-036).
  const bothEmpty = primary.length === 0 && secondary.length === 0;
  const usesDefaults =
    bothEmpty || (sameMuscles(primary, defaults.primary) && sameMuscles(secondary, defaults.secondary));
  const inPrimary = new Set(primary.map((m) => m.toLowerCase()));
  const inSecondary = new Set(secondary.map((m) => m.toLowerCase()));
  let source: string;
  if (!usesDefaults) source = 'Your own.';
  else if (!defaultMuscles) source = 'None set. This lift’s sets aren’t counted toward any muscle.';
  else if (bothEmpty) source = 'Built-in defaults, which apply when both lists are empty.';
  else source = 'Built-in defaults.';

  async function handleSave() {
    const parsed = parseProgressionDraft(progression, { incrementWithoutType: true });
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await patchLiftMetadata(initialMetadata.lift, {
        muscleGroups: usesDefaults ? [] : primary,
        secondaryMuscleGroups: usesDefaults ? [] : secondary,
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
    setPrimary([...defaults.primary]);
    setSecondary([...defaults.secondary]);
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
        <label className={styles.label} htmlFor="primaryMuscles">
          Primary Muscles
        </label>
        <CatalogTagPicker
          id="primaryMuscles"
          value={primary}
          onChange={setPrimary}
          options={MUSCLE_GROUPS.filter((m) => !inSecondary.has(m.toLowerCase()))}
          placeholder="Search muscles…"
          disabled={saving}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="secondaryMuscles">
          Secondary Muscles (count ½)
        </label>
        <CatalogTagPicker
          id="secondaryMuscles"
          value={secondary}
          onChange={setSecondary}
          options={MUSCLE_GROUPS.filter((m) => !inPrimary.has(m.toLowerCase()))}
          placeholder="Search muscles…"
          disabled={saving}
        />
      </div>
      <p className={styles.hint} aria-live="polite">
        Source: {source}
      </p>

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
        incrementWithoutType
        classNames={{ field: styles.field, label: styles.label, input: styles.input }}
      />
      <p className={styles.hint}>
        How this lift&apos;s training max moves. A program row that sets its own progression still
        wins inside that program; every built-in program does. The increment applies outside a
        program, even when the lift follows your default.
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

      {/* Each modification saves on its own, apart from Save Changes above. */}
      <LiftModificationsEditor program={program} lift={initialMetadata.lift} />
    </div>
  );
}
