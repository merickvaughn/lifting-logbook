'use client';

import styles from '../onboarding.module.css';
import { valuesAreTrainingMax, type DiscoveryMethod } from '../lib';

type Max = { lift: string; oneRm: number | null; trainingMax: number };

type Props = {
  maxes: Max[];
  method: DiscoveryMethod;
  onConfirm: () => void;
  isPending: boolean;
  macrocycleError?: string | null;
};

export function StepConfirm({ maxes, method, onConfirm, isPending, macrocycleError }: Props) {
  // For `tm`/`import` the value is already the training max, so there is no 1RM
  // to show and no 90% derivation; the other methods display the 1RM with the
  // derived training max alongside it.
  const tmDirect = valuesAreTrainingMax(method);

  return (
    <>
      <h2 className={styles.stepTitle}>Confirm your training maxes</h2>
      <p className={styles.stepHint}>
        {tmDirect
          ? "Training maxes as entered — we'll use these as-is."
          : 'Estimated 1-rep maxes based on what you entered. Training maxes use 90% of the 1RM.'}
      </p>
      <div className={styles.maxesGrid}>
        {maxes.map(({ lift, oneRm, trainingMax }) => (
          <div key={lift} className={styles.maxRow}>
            <span className={styles.maxRowLabel}>{lift}</span>
            <span className={styles.maxRowValue}>
              {tmDirect ? (
                trainingMax > 0 ? `TM ${trainingMax} lb` : '—'
              ) : (
                <>
                  {oneRm != null && oneRm > 0 ? `${oneRm} lb` : '—'}
                  {oneRm != null && oneRm > 0 && (
                    <span
                      className={styles.unitLabel}
                      style={{ marginLeft: 'var(--space-2)' }}
                    >
                      (TM {trainingMax} lb)
                    </span>
                  )}
                </>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className={styles.detailActions}>
        <button
          type="button"
          className={styles.btnSuccess}
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? 'Starting…' : 'Start My Program'}
        </button>
      </div>
      {macrocycleError && (
        <p className={styles.errorNote} role="alert">{macrocycleError}</p>
      )}
    </>
  );
}
