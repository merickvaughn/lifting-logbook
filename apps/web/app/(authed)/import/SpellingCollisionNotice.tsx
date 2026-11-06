'use client';

import { useState } from 'react';
import type { ImportSpellingCollision, LiftClassification } from '@lifting-logbook/types';
import { LIFT_CLASSIFICATIONS } from './liftClassifications';
import styles from './import.module.css';

type CollisionRow = ImportSpellingCollision['rows'][number];

function KeepRowForm({
  row,
  onKeep,
}: {
  row: CollisionRow;
  onKeep: (name: string, classification: LiftClassification) => Promise<string | null>;
}) {
  // The spelling itself is taken: a row collides because the app already knows that name.
  const [name, setName] = useState(`${row.spelling} (custom)`);
  const [classification, setClassification] = useState<LiftClassification | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function keep() {
    if (!classification || name.trim() === '') return;
    setCreating(true);
    setError(null);
    setError(await onKeep(name.trim(), classification));
    setCreating(false);
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
        aria-label={`Custom lift name for ${row.spelling}`}
        onChange={(e) => setName(e.target.value)}
      />
      <div className={styles.chipRow}>
        {LIFT_CLASSIFICATIONS.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`${styles.chip} ${classification === c.value ? styles.chipActive : ''}`}
            aria-pressed={classification === c.value}
            onClick={() => setClassification(c.value)}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          className={styles.createLiftConfirm}
          disabled={!classification || name.trim() === ''}
          aria-label={`Keep ${row.spelling} as a custom lift`}
          onClick={keep}
        >
          {creating ? 'Creating…' : 'Keep'}
        </button>
      </div>
      {error && <span className={styles.createLiftError}>{error}</span>}
    </div>
  );
}

/**
 * Warns that rows of a training-max file spell one lift differently, and lets the user keep any
 * of them as a custom lift instead (#1135). What the warning says depends on where they store:
 * under one stored lift only the newest is written, while under two both are written and which
 * one a program reads depends on the name it plans.
 *
 * `rows` leaves out the ones already kept, and with one left there is nothing to warn about.
 * The wizard's fieldset disables these controls while `onKeep` runs.
 */
export default function SpellingCollisionNotice({
  label,
  rows,
  onKeep,
}: {
  label: string;
  rows: ImportSpellingCollision['rows'];
  onKeep: (row: CollisionRow, name: string, classification: LiftClassification) => Promise<string | null>;
}) {
  const [newest] = rows;
  if (!newest || rows.length < 2) return null;
  const spellings = rows.map((row) => row.spelling);
  const named = `${spellings.slice(0, -1).join(', ')} and ${spellings[spellings.length - 1]} are both ${label}`;
  return (
    <div className={styles.infoBox} role="status">
      <p>
        {rows.every((row) => row.lift === newest.lift)
          ? `${named}, so only the most recent max is stored (${newest.spelling}, ${newest.weight} lbs). To keep another max, keep its row as a custom lift.`
          : `${named}. Their maxes are stored separately, but a program uses one of them for this lift, and not always the most recent. To keep them apart, keep a row as a custom lift.`}
      </p>
      {rows.map((row) => (
        <KeepRowForm
          key={row.spelling}
          row={row}
          onKeep={(name, classification) => onKeep(row, name, classification)}
        />
      ))}
    </div>
  );
}
