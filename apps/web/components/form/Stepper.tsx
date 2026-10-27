'use client';

import styles from './form.module.css';

/**
 * A number changed by − and + buttons, clamped to `[min, max]`. `name` is the accessible
 * name: the buttons read "Decrease <name>" and "Increase <name>", and the value is an
 * `<output>` named `name`.
 */
export function Stepper({
  name,
  value,
  onChange,
  step = 1,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  format = String,
}: {
  name: string;
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  format?: (value: number) => string;
}) {
  // Rounded to 2 places so a 2.5 or 0.5 step never accumulates float drift.
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next * 100) / 100));
  return (
    <span className={styles.stepper}>
      <button
        type="button"
        className={`${styles.stepBtn} focus-ring`}
        aria-label={`Decrease ${name}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
      >
        −
      </button>
      <output className={styles.stepVal} aria-label={name}>
        {format(value)}
      </output>
      <button
        type="button"
        className={`${styles.stepBtn} focus-ring`}
        aria-label={`Increase ${name}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
      >
        +
      </button>
    </span>
  );
}
