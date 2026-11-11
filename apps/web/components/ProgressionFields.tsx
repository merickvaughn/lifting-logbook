'use client';

import { LIFT_PROGRESSION_TYPES, PROGRESSION_REPS_LIMITS } from '@lifting-logbook/types';
import { PROGRESSION_LABELS, ProgressionDraft } from '@/lib/progression';

interface Props {
  /** Prefixes every control id, so two instances on one page stay distinct. */
  idPrefix: string;
  /** Label of the type select. */
  label: string;
  /** Text of the "no type of its own" option. */
  unsetLabel: string;
  value: ProgressionDraft;
  onChange: (next: ProgressionDraft) => void;
  disabled?: boolean;
  classNames?: { field?: string; label?: string; input?: string };
}

/**
 * A progression type picker with its increment and rep range (#1210): a labelled native
 * select and labelled number fields. The number fields apply to the chosen type, so they're
 * disabled until one is chosen.
 */
export default function ProgressionFields({
  idPrefix,
  label,
  unsetLabel,
  value,
  onChange,
  disabled = false,
  classNames = {},
}: Props) {
  const noType = value.type === '';
  const field = (key: 'increment' | 'repsLow' | 'repsHigh', text: string, step: string, max?: number) => (
    <div className={classNames.field}>
      <label className={classNames.label} htmlFor={`${idPrefix}-${key}`}>
        {text}
      </label>
      <input
        id={`${idPrefix}-${key}`}
        className={classNames.input}
        type="number"
        inputMode={key === 'increment' ? 'decimal' : 'numeric'}
        min={key === 'increment' ? 0 : PROGRESSION_REPS_LIMITS.MIN}
        max={max}
        step={step}
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        disabled={disabled || noType}
      />
    </div>
  );

  return (
    <>
      <div className={classNames.field}>
        <label className={classNames.label} htmlFor={`${idPrefix}-type`}>
          {label}
        </label>
        <select
          id={`${idPrefix}-type`}
          className={classNames.input}
          value={value.type}
          onChange={(e) => onChange({ ...value, type: e.target.value as ProgressionDraft['type'] })}
          disabled={disabled}
        >
          <option value="">{unsetLabel}</option>
          {LIFT_PROGRESSION_TYPES.map((type) => (
            <option key={type} value={type}>
              {PROGRESSION_LABELS[type]}
            </option>
          ))}
        </select>
      </div>
      {field('increment', 'Increment', 'any')}
      {field('repsLow', 'Rep range bottom', '1', PROGRESSION_REPS_LIMITS.MAX)}
      {field('repsHigh', 'Rep range top', '1', PROGRESSION_REPS_LIMITS.MAX)}
    </>
  );
}
