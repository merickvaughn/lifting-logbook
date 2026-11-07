'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  ESTIMATE_FLOOR_INCREMENT,
  estimateOneRepMax,
  estimateRepMax,
  formatWeight,
} from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import styles from './RepMaxCalculator.module.css';

/** Focusable descendants, in DOM order: the set the focus trap cycles through. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

/** The rep counts the table estimates a weight for. */
const REP_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** The Brzycki formula reaches its asymptote at 37 reps. */
const MAX_REPS = 36;

function weightMessage(text: string): string | null {
  if (text === '') return null;
  const weight = Number(text);
  return Number.isFinite(weight) && weight > 0 ? null : 'Enter a weight above 0.';
}

function repsMessage(text: string): string | null {
  if (text === '') return null;
  const reps = Number(text);
  if (!Number.isFinite(reps) || reps <= 0) return 'Enter at least 1 rep.';
  if (!Number.isInteger(reps)) return 'Enter a whole number of reps.';
  if (reps > MAX_REPS) return `The estimate only works up to ${MAX_REPS} reps.`;
  return null;
}

/**
 * A button that opens a dialog estimating rep maxes from one set. It only calculates:
 * nothing is saved, and the page behind it is left as it was, so a lifter can use it
 * mid-workout. The entries stay until the page does, for checking again between sets.
 *
 * Weights are entered and shown in the lifter's preferred unit, with no conversion.
 */
export default function RepMaxCalculator({ unit }: { unit: WeightUnit }) {
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const weightRef = useRef<HTMLInputElement>(null);
  const id = useId();

  // Dialog semantics: move focus in on open, hand it back on close, close on Escape,
  // and keep Tab inside while it is open.
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const dialog = dialogRef.current;
    weightRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      const active = document.activeElement;
      // A click on the dialog's text leaves focus on <body>, outside the dialog.
      if (!dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  const repsError = repsMessage(reps);
  const canEstimate = weight !== '' && reps !== '' && !weightMessage(weight) && !repsError;
  const oneRepMax = canEstimate ? estimateOneRepMax(Number(weight), Number(reps)) : 0;
  const display = (value: number) => formatWeight(value, unit, unit);

  // A valid set can still floor to nothing: 2 lbs × 1 is under one increment.
  const weightError =
    weightMessage(weight) ??
    (canEstimate && oneRepMax === 0 ?
      `Too light to estimate: estimates round down to the nearest ${display(ESTIMATE_FLOOR_INCREMENT)}.`
    : null);

  return (
    <div className={styles.row}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} focus-ring`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Rep max calculator
      </button>

      {open && (
        <div
          className={styles.overlay}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-title`}
          >
            <div className={styles.header}>
              <h2 id={`${id}-title`} className={styles.title}>
                Rep max calculator
              </h2>
              <button
                type="button"
                className={`${styles.close} focus-ring`}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>

            <div className={styles.fields}>
              <div className={styles.field}>
                <label htmlFor={`${id}-weight`}>Weight ({unit})</label>
                <input
                  ref={weightRef}
                  id={`${id}-weight`}
                  className={`${styles.input} focus-ring`}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={weight}
                  aria-invalid={weightError ? true : undefined}
                  aria-describedby={weightError ? `${id}-weight-error` : undefined}
                  onChange={(event) => setWeight(event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor={`${id}-reps`}>Reps</label>
                <input
                  id={`${id}-reps`}
                  className={`${styles.input} focus-ring`}
                  type="number"
                  inputMode="numeric"
                  step="1"
                  value={reps}
                  aria-invalid={repsError ? true : undefined}
                  aria-describedby={repsError ? `${id}-reps-error` : undefined}
                  onChange={(event) => setReps(event.target.value)}
                />
              </div>
            </div>

            {weightError && (
              <p id={`${id}-weight-error`} role="status" className={styles.error}>
                {weightError}
              </p>
            )}
            {repsError && (
              <p id={`${id}-reps-error`} role="status" className={styles.error}>
                {repsError}
              </p>
            )}

            {oneRepMax > 0 ?
              <>
                <p role="status" className={styles.oneRepMax}>
                  <span>Estimated one-rep max</span>
                  <strong>{display(oneRepMax)}</strong>
                </p>
                <table className={styles.table}>
                  <caption className={styles.caption}>Estimated weight for each rep count</caption>
                  <thead>
                    <tr>
                      <th scope="col">Reps</th>
                      <th scope="col">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {REP_COUNTS.map((count) => {
                      const estimate = estimateRepMax(Number(weight), Number(reps), count);
                      return (
                        <tr key={count}>
                          <th scope="row">{count}</th>
                          <td>{estimate > 0 ? display(estimate) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            : !weightError && !repsError && (
                <p className={styles.note}>Enter a weight and reps from one set.</p>
              )
            }

            <p className={styles.note}>
              Estimates use the Brzycki formula, rounded down to the nearest{' '}
              {display(ESTIMATE_FLOOR_INCREMENT)}. Nothing here is saved.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
