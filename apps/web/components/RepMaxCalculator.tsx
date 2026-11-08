'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import {
  ESTIMATE_FLOOR_INCREMENT,
  MAX_ESTIMATE_REPS,
  estimateOneRepMax,
  estimateRepMax,
  formatWeight,
} from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import { APP_NAV_TOOLS_ID } from '@/lib/app-nav-tools';
import { useFocusTrap } from '@/lib/useFocusTrap';
import styles from './RepMaxCalculator.module.css';

/** The rep counts the table estimates a weight for. */
const REP_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** What the lifter can round estimates down to, in their preferred unit. */
const ROUNDING_OPTIONS = [1.25, 2.5, 5, 10] as const;

/** Past this, a weight is a typing slip, such as a stray exponent. */
const MAX_WEIGHT = 9999;

const UNREADABLE_MESSAGE = 'Enter a number.';

function weightMessage(text: string, unit: WeightUnit): string | null {
  if (text === '') return null;
  const weight = Number(text);
  if (!(weight > 0)) return 'Enter a weight above 0.';
  if (weight > MAX_WEIGHT) return `Enter a weight up to ${formatWeight(MAX_WEIGHT, unit, unit)}.`;
  return null;
}

function repsMessage(text: string): string | null {
  if (text === '') return null;
  const reps = Number(text);
  if (!Number.isFinite(reps) || reps <= 0) return 'Enter at least 1 rep.';
  if (!Number.isInteger(reps)) return 'Enter a whole number of reps.';
  if (reps > MAX_ESTIMATE_REPS) return `The estimate only works up to ${MAX_ESTIMATE_REPS} reps.`;
  return null;
}

/**
 * A button that opens a dialog estimating rep maxes from one set. It only calculates:
 * nothing is saved, and the page behind it is left as it was, so a lifter can use it
 * mid-workout. The entries stay until the page does, for checking again between sets.
 *
 * The button goes in the sticky app header through a portal, so a lifter partway down a page
 * can reach it without scrolling and it covers nothing. On the server and until this mounts,
 * there is no button.
 *
 * Weights are entered and shown in the lifter's preferred unit, with no conversion.
 */
export default function RepMaxCalculator({ unit }: { unit: WeightUnit }) {
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const [increment, setIncrement] = useState<number>(ESTIMATE_FLOOR_INCREMENT);
  // A number input reports text it can't read, such as "200e", as an empty value.
  const [weightUnreadable, setWeightUnreadable] = useState(false);
  const [repsUnreadable, setRepsUnreadable] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const weightRef = useRef<HTMLInputElement>(null);
  const pressedBackdropRef = useRef(false);
  const id = useId();
  const pathname = usePathname();

  useEffect(() => {
    setToolsSlot(document.getElementById(APP_NAV_TOOLS_ID));
  }, []);

  // A layout keeps this mounted across a workout's views, and Back doesn't pass through
  // the dialog's Close button, so a new page has to close it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useFocusTrap(dialogRef, {
    active: open,
    onEscape: () => setOpen(false),
    initialFocusRef: weightRef,
    // Safari doesn't focus a button on click, so the opener can be <body>.
    returnFocus: () => triggerRef.current,
  });

  // The inputs reopen empty, so what they couldn't read no longer applies.
  useEffect(() => {
    if (open) return;
    setWeightUnreadable(false);
    setRepsUnreadable(false);
  }, [open]);

  const display = (value: number) => formatWeight(value, unit, unit);

  const weightInputError = weightUnreadable ? UNREADABLE_MESSAGE : weightMessage(weight, unit);
  const repsError = repsUnreadable ? UNREADABLE_MESSAGE : repsMessage(reps);
  const canEstimate = weight !== '' && reps !== '' && !weightInputError && !repsError;
  const oneRepMax = canEstimate ? estimateOneRepMax(Number(weight), Number(reps), increment) : 0;

  // A valid set can still floor to nothing: 2 lbs × 1 is under one increment.
  const weightError =
    weightInputError ??
    (canEstimate && oneRepMax === 0 ?
      `Too light to estimate: estimates round down to the nearest ${display(increment)}.`
    : null);

  return (
    <>
      {toolsSlot &&
        createPortal(
          <button
            ref={triggerRef}
            type="button"
            className={`${styles.trigger} focus-ring`}
            aria-label="Rep max calculator"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            Rep max
          </button>,
          toolsSlot,
        )}

      {open && (
        <div
          className={styles.overlay}
          // Only a press that starts here closes it: dragging a selection out of an input
          // ends in a click on the backdrop too.
          onMouseDown={(event) => {
            pressedBackdropRef.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (pressedBackdropRef.current && event.target === event.currentTarget) setOpen(false);
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
                  // Not onChange: React skips it when the value stays empty, as it does for "-".
                  onInput={(event) => setWeightUnreadable(event.currentTarget.validity.badInput)}
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
                  onInput={(event) => setRepsUnreadable(event.currentTarget.validity.badInput)}
                />
              </div>
              <div className={`${styles.field} ${styles.wide}`}>
                <label htmlFor={`${id}-rounding`}>Round down to</label>
                <select
                  id={`${id}-rounding`}
                  className={`${styles.input} focus-ring`}
                  value={increment}
                  onChange={(event) => setIncrement(Number(event.target.value))}
                >
                  {ROUNDING_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {display(option)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Mounted before its content changes: a live region inserted along with its
                message may never be announced. */}
            <div role="status">
              {weightError && (
                <p id={`${id}-weight-error`} className={styles.error}>
                  {weightError}
                </p>
              )}
              {repsError && (
                <p id={`${id}-reps-error`} className={styles.error}>
                  {repsError}
                </p>
              )}
              {oneRepMax > 0 && (
                <p className={styles.oneRepMax}>
                  <span>Estimated one-rep max</span>
                  <strong>{display(oneRepMax)}</strong>
                </p>
              )}
            </div>

            {oneRepMax > 0 ?
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
                    const estimate = estimateRepMax(Number(weight), Number(reps), count, increment);
                    return (
                      <tr key={count}>
                        <th scope="row">{count}</th>
                        <td>{estimate > 0 ? display(estimate) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            : !weightError && !repsError && (
                <p className={styles.note}>Enter a weight and reps from one set.</p>
              )
            }

            <p className={styles.note}>Estimates use the Brzycki formula. Nothing here is saved.</p>
          </div>
        </div>
      )}
    </>
  );
}
