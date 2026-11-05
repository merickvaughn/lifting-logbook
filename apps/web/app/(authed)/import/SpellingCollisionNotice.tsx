'use client';

import { useState } from 'react';
import type {
  CustomLiftResponse,
  ImportSpellingCollision,
  LiftClassification,
} from '@lifting-logbook/types';
import { createCustomLift } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './import.module.css';

type ClassificationOption = { value: LiftClassification; label: string };

function KeepRowForm({
  row,
  classifications,
  onKept,
}: {
  row: ImportSpellingCollision['rows'][number];
  classifications: readonly ClassificationOption[];
  onKept: (lift: CustomLiftResponse) => void;
}) {
  // The spelling itself is taken: a row collides because the app already knows that name.
  const [name, setName] = useState(`${row.spelling} (custom)`);
  const [classification, setClassification] = useState<LiftClassification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function keep() {
    if (!classification || name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const result = await createCustomLift({ name: name.trim(), classification });
      if (result.ok) onKept(result.data);
      else setError('That name is already taken. Try another.');
    } catch (err) {
      // No lift name in the context: it is free text from the user's file.
      logClientError('createCustomLift', err, { source: 'spelling-collision' });
      setError('Could not create the lift. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.createLiftAffordance}>
      <span className={styles.createLiftPrompt}>
        Keep {row.spelling} ({row.weight} lbs, {row.dateUpdated}) as a custom lift
      </span>
      <input
        type="text"
        className={styles.ambiguousInput}
        value={name}
        disabled={busy}
        aria-label={`Custom lift name for ${row.spelling}`}
        onChange={(e) => setName(e.target.value)}
      />
      <div className={styles.chipRow}>
        {classifications.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`${styles.chip} ${classification === c.value ? styles.chipActive : ''}`}
            aria-pressed={classification === c.value}
            disabled={busy}
            onClick={() => setClassification(c.value)}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          className={styles.createLiftConfirm}
          disabled={busy || !classification || name.trim() === ''}
          aria-label={`Keep ${row.spelling} as a custom lift`}
          onClick={keep}
        >
          {busy ? 'Creating…' : 'Keep'}
        </button>
      </div>
      {error && <span className={styles.createLiftError}>{error}</span>}
    </div>
  );
}

/**
 * Warns that rows of a training-max file spell one lift differently, so only one max applies,
 * and lets the user keep any of them as a custom lift instead (#1135).
 * `rows` leaves out the ones already kept, and with one left there is nothing to warn about.
 */
export default function SpellingCollisionNotice({
  label,
  rows,
  classifications,
  onKept,
}: {
  label: string;
  rows: ImportSpellingCollision['rows'];
  classifications: readonly ClassificationOption[];
  onKept: (spelling: string, lift: CustomLiftResponse) => void;
}) {
  const [newest] = rows;
  if (!newest || rows.length < 2) return null;
  const spellings = rows.map((row) => row.spelling);
  return (
    <div className={styles.infoBox} role="status">
      <p>
        {spellings.slice(0, -1).join(', ')} and {spellings[spellings.length - 1]} are both {label},
        so one max applies, normally the most recent ({newest.spelling}, {newest.weight} lbs). To
        keep another max, keep its row as a custom lift.
      </p>
      {rows.map((row) => (
        <KeepRowForm
          key={row.spelling}
          row={row}
          classifications={classifications}
          onKept={(lift) => onKept(row.spelling, lift)}
        />
      ))}
    </div>
  );
}
