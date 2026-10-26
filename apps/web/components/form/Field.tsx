'use client';

import { useId, type ReactNode } from 'react';
import styles from './form.module.css';

/**
 * A labelled settings row: the label and an optional hint beside (or, with `stack`, above)
 * the control. The row is a group named by the label and described by the hint, so a
 * screen reader hears the hint when it enters the control.
 */
export function Field({
  label,
  hint,
  stack = false,
  children,
}: {
  label: string;
  hint?: string;
  stack?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div
      className={`${styles.field} ${stack ? styles.fieldStack : ''}`}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
    >
      <div className={styles.fieldMeta}>
        <span id={`${id}-label`} className={styles.fieldLabel}>
          {label}
        </span>
        {hint && (
          <span id={`${id}-hint`} className={styles.fieldHint}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
