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

const list = (names: readonly string[]) =>
  `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// What the warning says depends on where the rows store: under one stored lift only the newest
// is written, while under two both are written, and which one a program reads depends on the
// name it plans. `rows` is most recent first, so each stored lift's first row is the one written.
function collisionMessage(label: string, rows: readonly CollisionRow[]): string {
  const byLift = new Map<string, CollisionRow[]>();
  for (const row of rows) byLift.set(row.lift, [...(byLift.get(row.lift) ?? []), row]);
  const onlyNewest = (shared: readonly CollisionRow[]) => {
    const [newest] = shared;
    return `only the most recent max in this file is stored (${newest?.spelling}, ${newest?.weight} lbs)`;
  };
  const named = `${list(rows.map((row) => row.spelling))} are both ${label}`;
  if (byLift.size === 1) {
    return `${named}, so ${onlyNewest(rows)}. To keep another max, keep its row as a custom lift.`;
  }
  const shared = [...byLift.values()]
    .filter((group) => group.length > 1)
    .map((group) => `Of ${list(group.map((row) => row.spelling))}, ${onlyNewest(group)}.`);
  return [
    `${named}. Their maxes are stored separately, but a program uses one of them for this lift, and not always the most recent.`,
    ...shared,
    'To keep them apart, keep a row as a custom lift.',
  ].join(' ');
}

/**
 * Warns that rows of a training-max file spell one lift differently, and lets the user keep any
 * of them as a custom lift instead (#1135).
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
  if (rows.length < 2) return null;
  return (
    <div className={styles.infoBox} role="status">
      <p>{collisionMessage(label, rows)}</p>
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
