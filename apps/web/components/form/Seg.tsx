'use client';

import styles from './form.module.css';

/**
 * A segmented single choice: a radiogroup of buttons, one checked. `label` is the group's
 * accessible name.
 */
export function Seg<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  /** `[value, visible label]` pairs, in display order. */
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className={styles.seg} role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={`${styles.segBtn} ${value === option ? styles.segBtnOn : ''} focus-ring`}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
