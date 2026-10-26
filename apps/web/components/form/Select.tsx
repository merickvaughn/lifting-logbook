'use client';

import styles from './form.module.css';

/** A native select. `label` is its accessible name. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  /** A plain value is its own label; a pair is `[value, visible label]`. */
  options: readonly (T | readonly [T, string])[];
  onChange: (next: T) => void;
}) {
  return (
    <select
      className={`${styles.select} focus-ring`}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((option) => {
        const [optionValue, text] = typeof option === 'string' ? [option, option] : option;
        return (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        );
      })}
    </select>
  );
}
