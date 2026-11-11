'use client';

import { LIFT_PROGRESSION_TYPES, PROGRESSION_REPS_LIMITS } from '@lifting-logbook/types';
import { PROGRESSION_LABELS, ProgressionDraft, ProgressionNumberField } from '@/lib/progression';

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
  /** Keep the increment editable with no type chosen (a lift's own increment applies to any type). */
  incrementWithoutType?: boolean;
  classNames?: { field?: string; label?: string; input?: string };
}

/**
 * A progression type picker with its increment and rep range (#1210): a labelled native
 * select and labelled number fields. The rep range applies to the chosen type, so it's
 * disabled until one is chosen; so is the increment, unless `incrementWithoutType`.
 */
export default function ProgressionFields({
  idPrefix,
  label,
  unsetLabel,
  value,
  onChange,
  disabled = false,
  incrementWithoutType = false,
  classNames = {},
}: Props) {
  const noType = value.type === '';
  const needsType = (key: ProgressionNumberField) => noType && !(key === 'increment' && incrementWithoutType);
  const field = (key: ProgressionNumberField, text: string, step: string, max?: number) => (
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
        onChange={(e) => {
          const rest = (value.badInput ?? []).filter((k) => k !== key);
          onChange({ ...value, [key]: e.target.value, badInput: e.target.validity.badInput ? [...rest, key] : rest });
        }}
        disabled={disabled || needsType(key)}
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
