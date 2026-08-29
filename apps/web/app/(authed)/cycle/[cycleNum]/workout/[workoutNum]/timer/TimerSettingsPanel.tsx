'use client';

import { useId, useState } from 'react';
import {
  TIMER_FIELD_COPY,
  formatDuration,
  parseDuration,
  resolveDuration,
} from '@lifting-logbook/core';
import type {
  TimerAlertMode,
  TimerDurationField,
  TimerLiftPlan,
  TimerPresetDurations,
  TimerSettings,
} from '@lifting-logbook/core';
import styles from './timer.module.css';

interface Props {
  settings: TimerSettings;
  onChange: (next: TimerSettings) => void;
  lifts: TimerLiftPlan[];
}

const ALERT_MODES: TimerAlertMode[] = ['Both', 'Beep', 'Vibrate', 'Silent'];

/** One hour — past any real rest, and a bound on what can reach storage. */
const MAX_DURATION_SECONDS = 3600;

/** Structural clone — every value in the settings tree is a plain number, string or boolean. */
function clone(settings: TimerSettings): TimerSettings {
  return {
    preset: settings.preset,
    presets: Object.fromEntries(
      Object.entries(settings.presets).map(([name, durations]) => [name, { ...durations }]),
    ),
    overrides: Object.fromEntries(
      Object.entries(settings.overrides).map(([lift, fields]) => [lift, { ...fields }]),
    ),
    context: { deloadOn: settings.context.deloadOn, deload: { ...settings.context.deload } },
    behavior: { ...settings.behavior },
  };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function DurationStepper({
  name,
  value,
  step,
  onChange,
}: {
  /** Accessible name — already disambiguated by {@link DurationRow}. */
  name: string;
  value: number;
  step: number;
  onChange: (next: number) => void;
}) {
  const id = useId();
  // Local draft so a half-typed "1:" doesn't get parsed to nonsense on every
  // keystroke; committed on blur or Enter.
  const [draft, setDraft] = useState<string | null>(null);

  function commit(text: string) {
    const parsed = parseDuration(text);
    // Unparseable input keeps the previous value rather than silently zeroing it.
    // Clamped at both ends: an hour is already far beyond any real rest, and an
    // unbounded value persists a phase that never ends.
    if (parsed !== null) onChange(Math.min(MAX_DURATION_SECONDS, Math.max(0, parsed)));
    setDraft(null);
  }

  return (
    <div className={styles.stepper}>
      <button
        type="button"
        className={`${styles.stepBtn} focus-ring`}
        aria-label={`Decrease ${name}`}
        onClick={() => onChange(Math.max(0, value - step))}
      >
        −
      </button>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className={styles.durationValue}
        aria-label={name}
        value={draft ?? formatDuration(value)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <button
        type="button"
        className={`${styles.stepBtn} focus-ring`}
        aria-label={`Increase ${name}`}
        onClick={() => onChange(value + step)}
      >
        +
      </button>
    </div>
  );
}

function DurationRow({
  label,
  hint,
  context,
  value,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  /**
   * Disambiguator folded into the accessible name.
   *
   * "Working set" appears three times on this page — under the preset, under the
   * deload defaults, and again inside every per-lift override panel. The visible
   * hint separates them for a sighted user; without this, all three would carry
   * the identical accessible name and be indistinguishable to a screen reader.
   */
  context?: string;
  value: number;
  step: number;
  onChange: (next: number) => void;
}) {
  const name = context ? `${label} (${context})` : label;
  return (
    <div className={styles.settingRow}>
      <span className={styles.settingMeta}>
        <span className={styles.settingName}>{label}</span>
        <span className={styles.settingHint}>{hint}</span>
      </span>
      <DurationStepper name={name} value={value} step={step} onChange={onChange} />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={styles.settingRow}>
      <span className={styles.settingMeta}>
        <span className={styles.settingName}>{label}</span>
        <span className={styles.settingHint}>{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`${styles.switch} ${checked ? styles.switchOn : ''} focus-ring`}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function SegmentedRow<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className={styles.settingRow}>
      <span className={styles.settingMeta}>
        <span className={styles.settingName}>{label}</span>
        <span className={styles.settingHint}>{hint}</span>
      </span>
      <div className={styles.segRow} role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={`${styles.seg} ${value === option ? styles.segActive : ''} focus-ring`}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function TimerSettingsPanel({ settings, onChange, lifts }: Props) {
  const [openLift, setOpenLift] = useState<string | null>(null);

  const activePreset: TimerPresetDurations | undefined = settings.presets[settings.preset];

  function setPresetField(field: TimerDurationField, value: number) {
    const next = clone(settings);
    const preset = next.presets[next.preset];
    if (preset) preset[field] = value;
    onChange(next);
  }

  function setOverride(lift: string, field: TimerDurationField, value: number) {
    const next = clone(settings);
    next.overrides[lift] = { ...next.overrides[lift], [field]: value };
    onChange(next);
  }

  function clearOverrides(lift: string) {
    const next = clone(settings);
    delete next.overrides[lift];
    onChange(next);
  }

  function setDeloadField(field: TimerDurationField, value: number) {
    const next = clone(settings);
    next.context.deload[field] = value;
    onChange(next);
  }

  function durationRow(field: TimerDurationField) {
    const copy = TIMER_FIELD_COPY[field];
    return (
      <DurationRow
        key={field}
        label={copy.label}
        hint={copy.hint}
        step={copy.step}
        value={activePreset?.[field] ?? 0}
        onChange={(value) => setPresetField(field, value)}
      />
    );
  }

  return (
    <div className={styles.settingsPanel}>
      <h1 className={styles.settingsTitle}>Timer settings</h1>
      <p className={styles.sessionMeta}>
        Durations apply to every workout unless a lift overrides them.
      </p>

      <h2 className={styles.sectionTitle}>Preset</h2>
      <div className={styles.presetRow} role="radiogroup" aria-label="Duration preset">
        {Object.keys(settings.presets).map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={settings.preset === name}
            className={`${styles.preset} ${settings.preset === name ? styles.presetActive : ''} focus-ring`}
            onClick={() => onChange({ ...clone(settings), preset: name })}
          >
            {name}
          </button>
        ))}
      </div>

      <h2 className={styles.sectionTitle}>Set durations</h2>
      <div className={styles.card}>
        {durationRow('warmupSet')}
        {durationRow('workSet')}
      </div>

      <h2 className={styles.sectionTitle}>Rest</h2>
      <div className={styles.card}>
        {durationRow('restWarmup')}
        {durationRow('restWork')}
      </div>

      <h2 className={styles.sectionTitle}>Before every set</h2>
      <div className={styles.card}>{durationRow('prep')}</div>

      <h2 className={styles.sectionTitle}>Per-lift overrides</h2>
      <ul className={styles.overrideList}>
        {lifts.map((lift) => {
          const overrides = settings.overrides[lift.lift];
          const count = overrides ? Object.keys(overrides).length : 0;
          const isOpen = openLift === lift.lift;
          const panelId = `override-${encodeURIComponent(lift.lift)}`;
          const hasWarmups = lift.sets.some((s) => s.type === 'warmup');
          const fields: TimerDurationField[] = hasWarmups ?
            ['warmupSet', 'workSet', 'restWarmup', 'restWork', 'prep']
          : ['workSet', 'restWork', 'prep'];

          return (
            <li key={lift.lift} className={styles.overrideItem}>
              <button
                type="button"
                className={`${styles.overrideHead} focus-ring`}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenLift(isOpen ? null : lift.lift)}
              >
                <span
                  className={`${styles.overrideIcon} ${isOpen ? styles.overrideIconOpen : ''}`}
                  aria-hidden="true"
                >
                  ›
                </span>
                <span className={styles.overrideName}>{lift.lift}</span>
                <span
                  className={`${styles.overrideState} ${count > 0 ? styles.overrideStateSet : ''}`}
                >
                  {count > 0 ?
                    `${count} override${count > 1 ? 's' : ''}`
                  : `Follows ${settings.preset}`}
                </span>
              </button>

              <div id={panelId} className={styles.overrideBody} hidden={!isOpen}>
                {fields.map((field) => {
                  const copy = TIMER_FIELD_COPY[field];
                  const isOverridden = overrides?.[field] != null;
                  return (
                    <DurationRow
                      key={field}
                      label={copy.label}
                      hint={isOverridden ? 'Overridden' : `From ${settings.preset}`}
                      context={lift.lift}
                      step={copy.step}
                      value={resolveDuration(settings, lift.lift, field)}
                      onChange={(value) => setOverride(lift.lift, field, value)}
                    />
                  );
                })}
                {count > 0 && (
                  <button
                    type="button"
                    className={`${styles.clearBtn} focus-ring`}
                    onClick={() => clearOverrides(lift.lift)}
                  >
                    Clear overrides for {lift.lift}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className={styles.footNote}>
        Overrides replace the preset for that lift only. Everything left blank follows the preset
        above.
      </p>

      <h2 className={styles.sectionTitle}>Deload defaults</h2>
      <div className={styles.card}>
        <ToggleRow
          label="Deload week"
          hint="Applies to every lift in a deload week"
          checked={settings.context.deloadOn}
          onChange={(value) => {
            const next = clone(settings);
            next.context.deloadOn = value;
            onChange(next);
          }}
        />
        <DurationRow
          label="Working set"
          hint="Deload"
          context="Deload"
          step={TIMER_FIELD_COPY.workSet.step}
          value={settings.context.deload.workSet ?? TIMER_FIELD_COPY.workSet.step}
          onChange={(value) => setDeloadField('workSet', value)}
        />
        <DurationRow
          label="Between working sets"
          hint="Deload"
          context="Deload"
          step={TIMER_FIELD_COPY.restWork.step}
          value={settings.context.deload.restWork ?? TIMER_FIELD_COPY.restWork.step}
          onChange={(value) => setDeloadField('restWork', value)}
        />
      </div>

      <h2 className={styles.sectionTitle}>Alerts &amp; behavior</h2>
      <div className={styles.card}>
        <SegmentedRow
          label="Alert"
          hint="Fires at the end of every phase"
          options={ALERT_MODES}
          value={settings.behavior.alert}
          onChange={(value) => {
            const next = clone(settings);
            next.behavior.alert = value;
            onChange(next);
          }}
        />
        <ToggleRow
          label="Count down last 3 seconds"
          hint="Ticks at 3, 2, 1 before a set ends"
          checked={settings.behavior.countdown3}
          onChange={(value) => {
            const next = clone(settings);
            next.behavior.countdown3 = value;
            onChange(next);
          }}
        />
        <ToggleRow
          label="Count up past zero"
          hint="Rest keeps counting instead of auto-starting the next set"
          checked={settings.behavior.countUp}
          onChange={(value) => {
            const next = clone(settings);
            next.behavior.countUp = value;
            onChange(next);
          }}
        />
        <ToggleRow
          label="Keep screen awake"
          hint="While a timer is running"
          checked={settings.behavior.awake}
          onChange={(value) => {
            const next = clone(settings);
            next.behavior.awake = value;
            onChange(next);
          }}
        />
        <ToggleRow
          label="Skip warm-up timers"
          hint="Warm-ups run untimed — no setup, set, or rest countdown"
          checked={settings.behavior.skipWarmups}
          onChange={(value) => {
            const next = clone(settings);
            next.behavior.skipWarmups = value;
            onChange(next);
          }}
        />
      </div>
    </div>
  );
}
