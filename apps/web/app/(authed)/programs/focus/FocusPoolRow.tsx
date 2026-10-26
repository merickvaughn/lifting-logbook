'use client';

import { LIFT_CATALOG } from '@lifting-logbook/core';
import {
  FOCUS_INCLUDES,
  type FocusBlock,
  type FocusInclude,
  type FocusPoolEntry,
  type WeightUnit,
} from '@lifting-logbook/types';
import { Select } from '@/components/form/Select';
import { Stepper } from '@/components/form/Stepper';
import { INCLUDE_LABELS } from '@/lib/focusSetup';
import styles from './focus.module.css';

// The API's bounds (FocusPoolEntryDto), so a stepper never offers a value it rejects.
const MAX_SETS = 20;
const MAX_REPS = 100;
const MAX_WEIGHT = 5000;

/** "Side Delts, Traps (2°)": the catalog's muscles for a lift, secondary ones marked. */
function muscleTags(lift: string): string {
  const entry = LIFT_CATALOG.find((catalogLift) => catalogLift.name === lift);
  if (!entry) return '';
  return [...entry.muscles.primary, ...entry.muscles.secondary.map((muscle) => `${muscle} (2°)`)].join(', ');
}

/** One lift in a focus block's pool: when it is used, and its prescription inputs. */
export default function FocusPoolRow({
  block,
  entry,
  programLifts,
  unit,
  onChange,
  onRemove,
}: {
  block: FocusBlock;
  entry: FocusPoolEntry;
  /** The program's lifts, for "Skip when planned". */
  programLifts: readonly string[];
  unit: WeightUnit;
  onChange: (next: FocusPoolEntry) => void;
  onRemove: () => void;
}) {
  const { lift } = entry;
  const progression = block.progression;
  const set = <K extends keyof FocusPoolEntry>(key: K, value: FocusPoolEntry[K]) =>
    onChange({ ...entry, [key]: value });
  const weight = (value: number) => `${value} ${unit}`;

  return (
    <li className={styles.poolRow}>
      <div className={styles.poolTop}>
        <span className={styles.poolName}>{lift}</span>
        <span className={styles.poolTags}>{muscleTags(lift)}</span>
        <button
          type="button"
          className={`${styles.removeLift} focus-ring`}
          aria-label={`Remove ${lift} from the pool`}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      <div className={styles.poolGrid}>
        <div className={styles.mini}>
          <span aria-hidden="true">Include</span>
          <Select<FocusInclude>
            label={`Include ${lift}`}
            value={entry.include}
            options={FOCUS_INCLUDES.map((include) => [include, INCLUDE_LABELS[include]] as const)}
            onChange={(value) => set('include', value)}
          />
        </div>
        {entry.include === 'rule' && (
          <div className={styles.mini}>
            <span aria-hidden="true">Skip when planned</span>
            <Select
              label={`Skip ${lift} when this lift is planned`}
              value={entry.ruleLift}
              options={[
                ['', 'Choose lift…'] as const,
                // A rule saved against a lift the program no longer has stays selectable.
                ...(entry.ruleLift && !programLifts.includes(entry.ruleLift) ? [entry.ruleLift] : []),
                ...programLifts,
              ]}
              onChange={(value) => set('ruleLift', value)}
            />
          </div>
        )}
        {block.overlap === 'swap' && entry.include !== 'swap' && (
          <div className={styles.mini}>
            <span aria-hidden="true">On overlap, swap to</span>
            <Select
              label={`On overlap, swap ${lift} to`}
              value={entry.swapTo}
              options={[
                ['', 'Keep this lift'] as const,
                ...block.pool.filter((other) => other.lift !== lift).map((other) => other.lift),
              ]}
              onChange={(value) => set('swapTo', value)}
            />
          </div>
        )}
        <div className={styles.mini}>
          <span aria-hidden="true">Sets</span>
          <Stepper name={`Sets (${lift})`} value={entry.sets} min={1} max={MAX_SETS} onChange={(v) => set('sets', v)} />
        </div>
        {progression === 'double' ?
          <div className={styles.mini}>
            <span aria-hidden="true">Rep range</span>
            <span className={styles.pair}>
              <Stepper
                name={`Fewest reps (${lift})`}
                value={entry.repsLow}
                min={1}
                max={entry.repsHigh}
                onChange={(v) => set('repsLow', v)}
              />
              <Stepper
                name={`Most reps (${lift})`}
                value={entry.repsHigh}
                min={entry.repsLow}
                max={MAX_REPS}
                onChange={(v) => set('repsHigh', v)}
              />
            </span>
          </div>
        : <div className={styles.mini}>
            <span aria-hidden="true">Reps</span>
            <Stepper
              name={`Reps (${lift})`}
              value={entry.repsHigh}
              min={1}
              max={MAX_REPS}
              // Only the top of the range is shown, so the bottom follows it down.
              onChange={(v) => onChange({ ...entry, repsHigh: v, repsLow: Math.min(entry.repsLow, v) })}
            />
          </div>
        }
        {(progression === 'double' || progression === 'fixed') && (
          <div className={styles.mini}>
            <span aria-hidden="true">Weight</span>
            <Stepper
              name={`Weight (${lift})`}
              value={entry.weight}
              step={2.5}
              max={MAX_WEIGHT}
              format={weight}
              onChange={(v) => set('weight', v)}
            />
          </div>
        )}
        {progression === 'tm' && (
          <div className={styles.mini}>
            <span aria-hidden="true">TM · %</span>
            <span className={styles.pair}>
              <Stepper
                name={`Training max (${lift})`}
                value={entry.trainingMax}
                step={5}
                max={MAX_WEIGHT}
                format={weight}
                onChange={(v) => set('trainingMax', v)}
              />
              <Stepper
                name={`Percent of training max (${lift})`}
                value={entry.percent}
                step={5}
                max={100}
                format={(v) => `${v}%`}
                onChange={(v) => set('percent', v)}
              />
            </span>
          </div>
        )}
        {progression === 'rpe' && (
          <div className={styles.mini}>
            <span aria-hidden="true">RPE</span>
            <Stepper name={`RPE (${lift})`} value={entry.rpe} step={0.5} min={5} max={10} onChange={(v) => set('rpe', v)} />
          </div>
        )}
      </div>
    </li>
  );
}
