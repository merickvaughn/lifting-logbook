'use client';

import { useState } from 'react';
import type { LiftClassification } from '@lifting-logbook/types';
import { LIFT_CLASSIFICATIONS } from './liftClassifications';
import styles from './import.module.css';

interface CollisionRow {
  spelling: string;
  /** The stored `lift` this row writes to. Two rows can share one, and the first stores. */
  lift: string;
  /** What the row sets, as the warning shows it: `300 lbs`. */
  value: string;
  date?: string;
}

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
        Keep {row.spelling} ({row.value}{row.date ? `, ${row.date}` : ''}) as a custom lift
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

// Maxes and goals differ in which row wins a shared lift, and in who reads them.
const COPY = {
  max: {
    stored: 'most recent max',
    another: 'max',
    separate:
      'Their maxes are stored separately, but a program uses one of them for this lift, and not always the most recent.',
  },
  goal: {
    stored: 'first goal',
    another: 'goal',
    separate: 'Their goals are stored separately, but the goals page may show only one of them for this lift.',
  },
};

// What the warning says depends on where the rows store: under one stored lift only one row is
// written, while under two both are written, and which one is read depends on the name asked
// for. Each stored lift's first row in `rows` is the one written.
function collisionMessage(kind: keyof typeof COPY, label: string, rows: readonly CollisionRow[]): string {
  const copy = COPY[kind];
  const byLift = new Map<string, CollisionRow[]>();
  for (const row of rows) byLift.set(row.lift, [...(byLift.get(row.lift) ?? []), row]);
  const onlyOne = (shared: readonly CollisionRow[]) => {
    const [written] = shared;
    return `only the ${copy.stored} in this file is stored (${written?.spelling}, ${written?.value})`;
  };
  const named = `${list(rows.map((row) => row.spelling))} are both ${label}`;
  if (byLift.size === 1) {
    return `${named}, so ${onlyOne(rows)}. To keep another ${copy.another}, keep its row as a custom lift.`;
  }
  const shared = [...byLift.values()]
    .filter((group) => group.length > 1)
    .map((group) => `Of ${list(group.map((row) => row.spelling))}, ${onlyOne(group)}.`);
  return [`${named}. ${copy.separate}`, ...shared, 'To keep them apart, keep a row as a custom lift.'].join(' ');
}

/**
 * Warns that rows of a training-max or strength-goal file spell one lift differently, and lets
 * the user keep any of them as a custom lift instead (#1135, #1169).
 *
 * `rows` leaves out the ones already kept, and with one left there is nothing to warn about.
 * The wizard's fieldset disables these controls while `onKeep` runs.
 */
export default function SpellingCollisionNotice<R extends CollisionRow>({
  kind,
  label,
  rows,
  onKeep,
}: {
  kind: keyof typeof COPY;
  label: string;
  rows: readonly R[];
  onKeep: (row: R, name: string, classification: LiftClassification) => Promise<string | null>;
}) {
  if (rows.length < 2) return null;
  return (
    <div className={styles.infoBox} role="status">
      <p>{collisionMessage(kind, label, rows)}</p>
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
