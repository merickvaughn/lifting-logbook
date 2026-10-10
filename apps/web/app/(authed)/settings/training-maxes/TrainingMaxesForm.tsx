'use client';

import { useState } from 'react';
import { formatWeight } from '@lifting-logbook/core';
import {
  DEFAULT_WEIGHT_INCREMENT,
  type TrainingMaxResponse,
  type WeightUnit,
} from '@lifting-logbook/types';
import GlossaryLink from '@/components/GlossaryLink';
import { saveTrainingMaxes } from './actions';
import styles from './TrainingMaxesForm.module.css';

type RowState = {
  value: string;
  unit: WeightUnit;
  dateUpdated: string | null;
  error: string | null;
};

function buildInitialState(
  lifts: string[],
  maxes: TrainingMaxResponse[],
): Record<string, RowState> {
  const maxMap = new Map(maxes.map((m) => [m.lift, m]));
  const state: Record<string, RowState> = {};
  for (const lift of lifts) {
    const m = maxMap.get(lift);
    state[lift] = {
      value: m ? String(m.weight) : '',
      unit: m?.unit ?? 'lbs',
      dateUpdated: m?.dateUpdated ?? null,
      error: null,
    };
  }
  return state;
}

export default function TrainingMaxesForm({
  program,
  lifts,
  maxes,
  increments,
  unit = 'lbs',
}: {
  program: string;
  lifts: string[];
  maxes: TrainingMaxResponse[];
  /** Per-lift spinner `step`, keyed by lift name (see resolveStepIncrements). */
  increments: Record<string, number>;
  /**
   * Display-only preference, used for a read-only conversion hint next to the
   * input. The input itself and everything submitted on Save always stay in
   * the record's native unit — training maxes are directly-known values (see
   * docs/standards/training-max-precision.md), and this API has no real
   * per-record unit storage today, so converting the editable value itself
   * would risk silently corrupting a saved max.
   */
  unit?: WeightUnit;
}) {
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    buildInitialState(lifts, maxes),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function handleChange(lift: string, value: string) {
    setRows((prev) => ({
      ...prev,
      [lift]: { ...prev[lift], value, error: null },
    }));
  }

  function validate(): boolean {
    let valid = true;
    setRows((prev) => {
      const next = { ...prev };
      for (const lift of lifts) {
        const { value } = prev[lift];
        if (value === '') continue; // skip empty rows
        const n = Number(value);
        if (isNaN(n) || n <= 0) {
          next[lift] = { ...prev[lift], error: 'Enter a positive number' };
          valid = false;
        }
      }
      return next;
    });
    return valid;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaveError(null);
    setSaving(true);

    const changed = lifts
      .filter((lift) => rows[lift].value !== '')
      .map((lift) => ({
        lift: lift as TrainingMaxResponse['lift'],
        weight: Number(rows[lift].value),
        unit: rows[lift].unit,
      }));

    if (changed.length === 0) {
      setSaving(false);
      return;
    }

    try {
      const updated = await saveTrainingMaxes(program, { maxes: changed });
      const updatedMap = new Map(updated.map((m) => [m.lift, m]));
      setRows((prev) => {
        const next = { ...prev };
        for (const lift of lifts) {
          const m = updatedMap.get(lift);
          if (m) {
            next[lift] = {
              value: String(m.weight),
              unit: m.unit,
              dateUpdated: m.dateUpdated,
              error: null,
            };
          }
        }
        return next;
      });
    } catch {
      setSaveError('Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.container}>
      <div className={styles.headingRow}>
        <h2 className={styles.heading}>Training Maxes</h2>
        <GlossaryLink id="training-max" />
      </div>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Lift</th>
              <th>Weight</th>
              <th>Unit</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {lifts.map((lift) => {
              const row = rows[lift];
              return (
                <tr key={lift} className={row.error ? styles.rowError : undefined}>
                  <td className={styles.liftName} data-label="Lift">{lift}</td>
                  <td className={styles.weightCell} data-label="Weight">
                    <input
                      type="number"
                      step={increments[lift] ?? DEFAULT_WEIGHT_INCREMENT}
                      value={row.value}
                      placeholder="—"
                      aria-label={`${lift} training max`}
                      autoComplete="off"
                      className={styles.weightInput}
                      onChange={(e) => handleChange(lift, e.target.value)}
                      suppressHydrationWarning
                    />
                    {row.error && (
                      <span className={styles.errorText}>{row.error}</span>
                    )}
                    {unit !== row.unit && row.value !== '' && !isNaN(Number(row.value)) && (
                      <span className={styles.conversionHint}>
                        ≈ {formatWeight(Number(row.value), row.unit, unit)}
                      </span>
                    )}
                  </td>
                  <td className={styles.unit} data-label="Unit">{row.unit}</td>
                  <td className={styles.date} data-label="Last Updated">
                    {row.dateUpdated ?? <span className={styles.placeholder}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {saveError && <p className={styles.saveError}>{saveError}</p>}
      <button
        className={styles.saveButton}
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </section>
  );
}
