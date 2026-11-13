'use client';

import { useId, useState } from 'react';
import { formatWeight, liftIdFor } from '@lifting-logbook/core';
import {
  DEFAULT_WEIGHT_INCREMENT,
  type MissingTrainingMaxResponse,
  type SkippedLiftResponse,
  type WeightUnit,
} from '@lifting-logbook/types';
import {
  dismissMissingTrainingMax,
  undismissMissingTrainingMax,
  updateTrainingMaxes,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './MissingMaxRow.module.css';

/** One lift on offer, as the missing list reports it, or from a progression `skipped` entry. */
export type MissingMaxEntry = Pick<MissingTrainingMaxResponse, 'lift' | 'liftId' | 'estimate' | 'dismissed'> &
  Partial<Pick<MissingTrainingMaxResponse, 'setCount' | 'lastLoggedDate'>>;

/** What every place that asks passes to the row, besides the entry itself. */
export interface MissingMaxRowOptions {
  program: string;
  /** Which screen asked, for the error logs: `settings`, `workout`, `import`, … */
  source: string;
  /** The lifter's preferred unit. The max is saved in the stored unit; this adds a conversion hint. */
  preferredUnit?: WeightUnit;
  /** The weight input's step: the lifter's weight increment. */
  step?: number;
  /** After a saved max, with the weight saved. */
  onSetUp?: (lift: string, weight: number) => void;
  /** After a saved dismissal or its undo. */
  onDismissedChange?: (liftId: string, dismissed: boolean) => void;
}

/**
 * `2026-11-03` → `3 Nov`, with the year when it isn't this year's (`6 Jan 2025`), so an old
 * estimate doesn't read as a recent one. The date is a calendar day, so it is read as UTC.
 */
export function shortDate(iso: string, now: Date = new Date()): string {
  const sameYear = Number(iso.slice(0, 4)) === now.getFullYear();
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

function estimateLine(entry: MissingMaxEntry): string {
  const { estimate } = entry;
  if (!estimate) return 'No set to estimate from: enter a training max';
  const { from } = estimate;
  return `Estimated from ${from.weight} ${estimate.unit} × ${from.reps} on ${shortDate(from.date)}`;
}

function loggedLine(entry: MissingMaxEntry): string | null {
  if (entry.setCount === undefined || entry.lastLoggedDate === undefined) return null;
  const sets = `${entry.setCount} ${entry.setCount === 1 ? 'set' : 'sets'}`;
  return `${sets}, last on ${shortDate(entry.lastLoggedDate)}`;
}

/**
 * The offer to set up a training max for one lift (#1246): its weight, prefilled with the
 * estimate, and **Set up** plus **Don't ask again** (or **Ask again** once dismissed). Every place
 * that asks uses it. A failed write keeps the value and shows the error inline.
 */
export function MissingMaxRow({
  entry,
  program,
  source,
  preferredUnit,
  step = DEFAULT_WEIGHT_INCREMENT,
  onSetUp,
  onDismissedChange,
}: MissingMaxRowOptions & { entry: MissingMaxEntry }) {
  const estimateId = useId();
  const errorId = useId();
  const unit = entry.estimate?.unit ?? 'lbs';
  const [value, setValue] = useState(entry.estimate ? String(entry.estimate.weight) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logged = loggedLine(entry);
  const context = { program, liftId: entry.liftId, source };

  async function setUp() {
    const weight = Number(value);
    if (value === '' || !Number.isFinite(weight) || weight <= 0) {
      setError('Enter a positive number');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateTrainingMaxes(program, { maxes: [{ lift: entry.lift, weight, unit }] });
      onSetUp?.(entry.lift, weight);
    } catch (err) {
      logClientError('updateTrainingMaxes', err, context);
      setError("Couldn't save the training max. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDismissed() {
    const dismissed = !entry.dismissed;
    setBusy(true);
    setError(null);
    try {
      if (dismissed) await dismissMissingTrainingMax(program, entry.liftId);
      else await undismissMissingTrainingMax(program, entry.liftId);
      onDismissedChange?.(entry.liftId, dismissed);
    } catch (err) {
      logClientError(dismissed ? 'dismissMissingTrainingMax' : 'undismissMissingTrainingMax', err, context);
      setError("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const showHint = preferredUnit && preferredUnit !== unit && value !== '' && Number.isFinite(Number(value));
  return (
    <li className={styles.row}>
      <div className={styles.lift}>
        <span className={styles.liftName}>{entry.lift}</span>
        {logged && <span className={styles.muted}>{logged}</span>}
      </div>
      <div className={styles.weight}>
        <input
          type="number"
          step={step}
          value={value}
          aria-label={`${entry.lift} training max`}
          aria-describedby={error ? `${estimateId} ${errorId}` : estimateId}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          className={styles.input}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        <span className={styles.muted}>{unit}</span>
        {showHint && <span className={styles.muted}>≈ {formatWeight(Number(value), unit, preferredUnit)}</span>}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={setUp} disabled={busy}>
          Set up
        </button>
        <button type="button" className={styles.secondary} onClick={toggleDismissed} disabled={busy}>
          {entry.dismissed ? 'Ask again' : "Don't ask again"}
        </button>
      </div>
      <p id={estimateId} className={styles.estimate}>
        {estimateLine(entry)}
      </p>
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </li>
  );
}

const SKIP_EXPLANATION: Record<Exclude<SkippedLiftResponse['reason'], 'no-training-max'>, string> = {
  'no-program-spec': "The program doesn't plan this lift, so nothing set its progression.",
  'no-target-reps': 'Its progression needs a rep target, and none was set.',
};

/**
 * A progression run's `skipped` lifts (#1150): a lift skipped for having no training max gets the
 * setup row, using its missing-list entry when the caller has one. Any other reason gets a plain
 * explanation and nothing to set up.
 */
export function SkippedLiftRows({
  skipped,
  missing = [],
  ...options
}: MissingMaxRowOptions & {
  skipped: readonly SkippedLiftResponse[];
  missing?: readonly MissingTrainingMaxResponse[];
}) {
  const byId = new Map(missing.map((m) => [m.liftId, m]));
  return (
    <ul className={styles.list}>
      {skipped.map((s) => {
        if (s.reason !== 'no-training-max') {
          return (
            <li key={`${s.lift}-${s.reason}`} className={styles.row}>
              <span className={styles.liftName}>{s.lift}</span>
              <p className={styles.estimate}>{SKIP_EXPLANATION[s.reason]}</p>
            </li>
          );
        }
        const liftId = liftIdFor(s.lift);
        const entry = byId.get(liftId) ?? { lift: s.lift, liftId, estimate: null, dismissed: false };
        return <MissingMaxRow key={liftId} entry={entry} {...options} />;
      })}
    </ul>
  );
}
