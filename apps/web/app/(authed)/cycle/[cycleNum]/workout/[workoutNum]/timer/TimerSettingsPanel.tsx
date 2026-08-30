'use client';

import { useId, useState } from 'react';
import {
  MAX_TIMER_DURATION_SECONDS,
  STANDARD_DURATIONS,
  TIMER_FIELD_COPY,
  formatDuration,
  parseDuration,
  resolveDurationEntry,
} from '@lifting-logbook/core';
import type {
  TimerAlertMode,
  TimerDurationField,
  TimerDurationSource,
  TimerLiftPlan,
  TimerPresetDurations,
  TimerSettings,
} from '@lifting-logbook/core';
import styles from './timer.module.css';

interface Props {
  settings: TimerSettings;
  onChange: (next: TimerSettings) => void;
  /**
   * Readonly: the caller passes `useWorkoutTimer`'s `effectiveLifts`, which has
   * a live run's pinned classification applied — see `TimerRunState.classifications`
   * in @lifting-logbook/core. Never the route's raw `lifts` prop; this panel's
   * "Rest follows …" label and per-field hints resolve from `lift.classification`
   * (below), and reading the unpinned version here could disagree with the
   * queue/dial about the same lift during a live run (issue #966).
   */
  lifts: readonly TimerLiftPlan[];
}

const ALERT_MODES: TimerAlertMode[] = ['Both', 'Beep', 'Vibrate', 'Silent'];

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
    // Enumerated, not spread, because `setDeloadField`/`setAccessoryField` mutate
    // the nested duration objects in place: a spread would alias them back to the
    // caller's settings and edit state the panel does not own. Completeness of the
    // *required* fields is enforced by the `TimerSettings` return type, not by the
    // enumeration — but an optional field added to TimerContext later would be
    // dropped here silently, which the type cannot catch.
    context: {
      deloadOn: settings.context.deloadOn,
      deload: { ...settings.context.deload },
      accessoryOn: settings.context.accessoryOn,
      accessory: { ...settings.context.accessory },
    },
    behavior: { ...settings.behavior },
  };
}

/**
 * What a duration row says it is following, given the rung that actually supplied
 * it.
 *
 * `standard` is defense-in-depth for a `TimerSettings` that did not come through
 * `normalizeTimerSettings` — no app path reaches it, because normalization
 * re-points a stale `preset` at a live key and rebuilds every preset field-by-field,
 * so the preset rung always hits for settings loaded from storage.
 *
 * The `default` branch is unreachable today and exists for its error message: a
 * sixth `TimerDurationSource` would otherwise surface as TS2366 ("function lacks
 * ending return statement"), which reads as a missing `return` rather than a
 * missing case.
 */
function sourceLabel(source: TimerDurationSource, presetName: string): string {
  switch (source) {
    case 'override':
      return 'Overridden';
    case 'deload':
      return 'Deload';
    case 'accessory':
      return 'Accessory';
    case 'preset':
      return presetName;
    case 'standard':
      return 'Standard';
    default: {
      const unhandled: never = source;
      return unhandled;
    }
  }
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
    // unbounded value persists a phase that never ends. The same ceiling is
    // enforced again at the normalization boundary (packages/core's toDuration),
    // via the shared MAX_TIMER_DURATION_SECONDS constant — this clamp is a UX
    // nicety (immediate feedback while typing), not the only bound.
    if (parsed !== null) onChange(Math.min(MAX_TIMER_DURATION_SECONDS, Math.max(0, parsed)));
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
   * "Working set" appears four times on this page — under the preset, under the
   * deload defaults, under the accessory defaults, and again inside every
   * per-lift override panel. The visible hint separates them for a sighted user;
   * without this, all four would carry the identical accessible name and be
   * indistinguishable to a screen reader.
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

  function setAccessoryField(field: TimerDurationField, value: number) {
    const next = clone(settings);
    next.context.accessory[field] = value;
    onChange(next);
  }

  /**
   * What a context row shows for a field that context does not set.
   *
   * Must be the rung the resolver actually falls through to — the active preset,
   * then Standard — not `STANDARD_DURATIONS` alone. A persisted context section
   * can carry a subset of fields (`normalizeTimerSettings` only replaces one that
   * narrowed to *nothing*), and showing Standard's 1:00 while the timer runs
   * "Light day"'s 0:45 makes the row disagree with the countdown — and writes the
   * wrong baseline back the moment a stepper is clicked.
   */
  function contextFallback(field: TimerDurationField): number {
    return activePreset?.[field] ?? STANDARD_DURATIONS[field];
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

      <h2 className={styles.sectionTitle}>Activation</h2>
      <div className={styles.card}>{durationRow('activation')}</div>
      <p className={styles.footNote}>
        The movement itself comes from the program — a lift only gets an activation phase when its
        program spec names one. A duration of 0:00, here or as a per-lift override below, drops the
        phase from the next session you start.
      </p>

      <h2 className={styles.sectionTitle}>Per-lift overrides</h2>
      <ul className={styles.overrideList}>
        {lifts.map((lift) => {
          const overrides = settings.overrides[lift.lift];
          const count = overrides ? Object.keys(overrides).length : 0;
          const isOpen = openLift === lift.lift;
          const panelId = `override-${encodeURIComponent(lift.lift)}`;
          const hasWarmups = lift.sets.some((s) => s.type === 'warmup');
          // Activation only where the program actually names a movement — a row
          // for a lift with none would control nothing, which is the defect that
          // kept this field out of #959 in the first place.
          const fields: TimerDurationField[] = [
            ...(lift.activation ? (['activation'] as const) : []),
            ...(hasWarmups ?
              (['warmupSet', 'workSet', 'restWarmup', 'restWork', 'prep'] as const)
            : (['workSet', 'restWork', 'prep'] as const)),
          ];
          // What this lift's REST follows when it has no overrides of its own —
          // one field, not the whole lift. Read off the rung that actually
          // resolves `restWork` rather than assuming the preset, which stopped
          // being true once the deload and accessory contexts existed.
          //
          // Deliberately a one-field summary: neither context sets `warmupSet`,
          // `restWarmup`, `prep` or `activation`, so a label claiming to describe
          // the whole lift would be wrong for every duration but this one and
          // `workSet` — four of the six rows a lift with an activation shows, and
          // three of five without one. The copy says "Rest
          // follows …" so the collapsed row does not overstate its scope; the
          // per-field `From <rung>` hints inside give the exact answer.
          const restFollows = sourceLabel(
            resolveDurationEntry(settings, lift.lift, 'restWork', lift.classification).source,
            settings.preset,
          );

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
                  : `Rest follows ${restFollows}`}
                </span>
              </button>

              <div id={panelId} className={styles.overrideBody} hidden={!isOpen}>
                {fields.map((field) => {
                  const copy = TIMER_FIELD_COPY[field];
                  const entry = resolveDurationEntry(
                    settings,
                    lift.lift,
                    field,
                    lift.classification,
                  );
                  return (
                    <DurationRow
                      key={field}
                      label={copy.label}
                      hint={
                        entry.source === 'override' ?
                          'Overridden'
                        : `From ${sourceLabel(entry.source, settings.preset)}`
                      }
                      context={lift.lift}
                      step={copy.step}
                      value={entry.seconds}
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
        An override wins over everything else, for that lift only. Anything left alone follows the
        deload and accessory rules below, then the preset above.
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
        {/*
          The fallback is contextFallback, not TIMER_FIELD_COPY[field].step —
          `step` is the stepper *increment* (5s), so a persisted blob whose
          deload section narrowed to only `restWork` used to render "Working set"
          as 0:05 and write that back on the next edit.
        */}
        <DurationRow
          label="Working set"
          hint="Deload"
          context="Deload"
          step={TIMER_FIELD_COPY.workSet.step}
          value={settings.context.deload.workSet ?? contextFallback('workSet')}
          onChange={(value) => setDeloadField('workSet', value)}
        />
        <DurationRow
          label="Between working sets"
          hint="Deload"
          context="Deload"
          step={TIMER_FIELD_COPY.restWork.step}
          value={settings.context.deload.restWork ?? contextFallback('restWork')}
          onChange={(value) => setDeloadField('restWork', value)}
        />
      </div>

      <h2 className={styles.sectionTitle}>Accessory lifts</h2>
      <div className={styles.card}>
        {/*
          "durations", not "rest": the shipped accessory defaults shorten the
          working-set countdown (60s -> 45s) as well as rest, so a label promising
          only shorter rest would understate what the switch does — and it is on
          by default, so every existing user gets both.
        */}
        <ToggleRow
          label="Shorter durations for accessories"
          hint="Working set and rest, for lifts the catalog classes as accessories"
          checked={settings.context.accessoryOn}
          onChange={(value) => {
            const next = clone(settings);
            next.context.accessoryOn = value;
            onChange(next);
          }}
        />
        <DurationRow
          label="Working set"
          hint="Accessory"
          context="Accessory"
          step={TIMER_FIELD_COPY.workSet.step}
          value={settings.context.accessory.workSet ?? contextFallback('workSet')}
          onChange={(value) => setAccessoryField('workSet', value)}
        />
        <DurationRow
          label="Between working sets"
          hint="Accessory"
          context="Accessory"
          step={TIMER_FIELD_COPY.restWork.step}
          value={settings.context.accessory.restWork ?? contextFallback('restWork')}
          onChange={(value) => setAccessoryField('restWork', value)}
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
