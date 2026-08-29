import type {
  TimerBehavior,
  TimerDurationField,
  TimerPresetDurations,
  TimerSettings,
} from './types';

/**
 * The three shipped presets.
 *
 * Deliberately whole-minute-friendly numbers a lifter can reason about, not
 * tuned constants — every one is editable, and the preset is only the starting
 * point the override chain falls back to.
 */
const SHIPPED_PRESETS = {
  Standard: { warmupSet: 30, workSet: 60, restWarmup: 90, restWork: 240, prep: 10 },
  'Heavy day': { warmupSet: 30, workSet: 60, restWarmup: 90, restWork: 300, prep: 15 },
  'Light day': { warmupSet: 30, workSet: 45, restWarmup: 60, restWork: 150, prep: 10 },
} satisfies Record<string, TimerPresetDurations>;

/**
 * The shipped presets, indexable by an arbitrary (possibly stale) preset name —
 * a persisted blob can name a preset that no longer exists.
 */
export const TIMER_PRESET_DEFAULTS: Record<string, TimerPresetDurations> = SHIPPED_PRESETS;

/**
 * The last-resort duration set.
 *
 * Exported separately from `TIMER_PRESET_DEFAULTS.Standard` because that lookup
 * goes through a `Record<string, …>` index, which `noUncheckedIndexedAccess`
 * widens to `| undefined` — and the one value that must never be undefined is the
 * fallback. Reads off the same literal, so the two can't drift.
 */
export const STANDARD_DURATIONS: TimerPresetDurations = SHIPPED_PRESETS.Standard;

/** Every duration field, in the order the settings UI renders them. */
export const TIMER_DURATION_FIELDS: readonly TimerDurationField[] = [
  'warmupSet',
  'workSet',
  'restWarmup',
  'restWork',
  'prep',
] as const;

/** Label and hint copy for each duration field. */
export const TIMER_FIELD_COPY: Record<
  TimerDurationField,
  { label: string; hint: string; step: number }
> = {
  warmupSet: { label: 'Warm-up set', hint: 'Time under the bar', step: 5 },
  workSet: { label: 'Working set', hint: 'Time under the bar', step: 5 },
  restWarmup: { label: 'Between warm-ups', hint: 'Enough to strip and load plates', step: 15 },
  restWork: { label: 'Between working sets', hint: 'The long one', step: 15 },
  prep: { label: 'Setup countdown', hint: 'Runs before every set — get in position', step: 5 },
};

const DEFAULT_BEHAVIOR: TimerBehavior = {
  alert: 'Both',
  countdown3: true,
  countUp: true,
  awake: true,
  skipWarmups: false,
};

/** A fresh settings blob — what a first-time user, or a corrupt blob, resolves to. */
export function defaultTimerSettings(): TimerSettings {
  return {
    preset: 'Standard',
    presets: structuredCloneish(TIMER_PRESET_DEFAULTS),
    overrides: {},
    context: { deloadOn: false, deload: { workSet: 60, restWork: 150 } },
    behavior: { ...DEFAULT_BEHAVIOR },
  };
}

/** Deep-enough clone for the plain-data shapes here; avoids sharing preset objects. */
function structuredCloneish(
  presets: Record<string, TimerPresetDurations>,
): Record<string, TimerPresetDurations> {
  const out: Record<string, TimerPresetDurations> = {};
  for (const [name, durations] of Object.entries(presets)) out[name] = { ...durations };
  return out;
}

/**
 * Resolves one duration for one lift, applying the precedence the settings UI
 * promises:
 *
 * 1. a per-lift override,
 * 2. the deload context (when the deload toggle is on),
 * 3. the active preset.
 *
 * Falls back to `Standard` when `preset` names a preset that no longer exists —
 * a persisted blob can outlive a renamed preset, and a missing duration should
 * degrade to a sensible countdown rather than to zero.
 */
export function resolveDuration(
  settings: TimerSettings,
  lift: string,
  field: TimerDurationField,
): number {
  const override = hasOwn(settings.overrides, lift) ? settings.overrides[lift]?.[field] : undefined;
  if (override != null) return override;

  if (settings.context.deloadOn) {
    const deload = settings.context.deload[field];
    if (deload != null) return deload;
  }

  const preset = hasOwn(settings.presets, settings.preset)
    ? settings.presets[settings.preset]
    : undefined;
  const value = preset?.[field];
  if (value != null) return value;

  return STANDARD_DURATIONS[field];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
//
// A persisted blob is untrusted input: it can be hand-edited, written by an
// older build, or truncated by a storage failure mid-write. Every accessor below
// narrows at runtime rather than casting, so a malformed field degrades to its
// default instead of surfacing as `undefined` inside the tick loop — where it
// would render `NaN:NaN` and never advance.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Own-property test, so an inherited `Object.prototype` member can never
 * masquerade as a stored preset or override.
 *
 * A plain `presets[name] != null` check is true for `"toString"`,
 * `"constructor"`, `"valueOf"` and friends even when nothing was ever stored
 * under that name — which let a persisted `preset: "toString"` pass validation
 * and resolve to a *function*, rendering every duration as 0:00 and letting a
 * stepper write a property onto `Object.prototype`.
 */
function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Writes an own data property, even when the key is `__proto__`.
 *
 * `target[key] = value` with `key === "__proto__"` invokes the inherited setter
 * and reassigns the object's prototype instead of storing anything, so the entry
 * would survive in memory and then serialize to `{}` — a lift by that name would
 * silently lose its overrides on reload.
 */
function defineOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** A duration is a finite, non-negative number of seconds. */
function toDuration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function toDurations(value: unknown, fallback: TimerPresetDurations): TimerPresetDurations {
  if (!isRecord(value)) return { ...fallback };
  const out = { ...fallback };
  for (const field of TIMER_DURATION_FIELDS) {
    const parsed = toDuration(value[field]);
    if (parsed != null) out[field] = parsed;
  }
  return out;
}

function toPartialDurations(value: unknown): Partial<TimerPresetDurations> {
  const out: Partial<TimerPresetDurations> = {};
  if (!isRecord(value)) return out;
  for (const field of TIMER_DURATION_FIELDS) {
    const parsed = toDuration(value[field]);
    if (parsed != null) out[field] = parsed;
  }
  return out;
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toAlertMode(value: unknown): TimerBehavior['alert'] {
  return value === 'Both' || value === 'Beep' || value === 'Vibrate' || value === 'Silent'
    ? value
    : DEFAULT_BEHAVIOR.alert;
}

/**
 * Merges an untrusted persisted value onto the defaults.
 *
 * Always returns a usable blob — there is no failure mode that reaches a caller,
 * because the only sensible response to a corrupt timer setting is a working
 * timer with default durations.
 */
export function normalizeTimerSettings(raw: unknown): TimerSettings {
  const base = defaultTimerSettings();
  if (!isRecord(raw)) return base;

  // Presets: keep every persisted preset (a user may have edited all three), but
  // rebuild each one field-by-field so a partial object can't leave a hole.
  const presets: Record<string, TimerPresetDurations> = {};
  if (isRecord(raw.presets)) {
    for (const [name, value] of Object.entries(raw.presets)) {
      const shipped = hasOwn(TIMER_PRESET_DEFAULTS, name) ? TIMER_PRESET_DEFAULTS[name] : undefined;
      defineOwn(presets, name, toDurations(value, shipped ?? STANDARD_DURATIONS));
    }
  }
  // A blob that lost its presets entirely still needs something to fall back to.
  if (Object.keys(presets).length === 0) Object.assign(presets, base.presets);

  // `hasOwn`, not `presets[raw.preset] != null` — the latter walks the prototype
  // chain, so every `Object.prototype` member passed as a valid preset name.
  const preset =
    typeof raw.preset === 'string' && hasOwn(presets, raw.preset)
      ? raw.preset
      : (Object.keys(presets)[0] ?? base.preset);

  const overrides: Record<string, Partial<TimerPresetDurations>> = {};
  if (isRecord(raw.overrides)) {
    for (const [lift, value] of Object.entries(raw.overrides)) {
      const parsed = toPartialDurations(value);
      // Drop an override that narrowed to nothing — an empty object would render
      // as "0 overrides" in the settings list while still counting as present.
      if (Object.keys(parsed).length > 0) defineOwn(overrides, lift, parsed);
    }
  }

  const rawContext = isRecord(raw.context) ? raw.context : {};
  const rawBehavior = isRecord(raw.behavior) ? raw.behavior : {};

  return {
    preset,
    presets,
    overrides,
    context: {
      deloadOn: toBool(rawContext.deloadOn, base.context.deloadOn),
      deload: Object.keys(toPartialDurations(rawContext.deload)).length
        ? toPartialDurations(rawContext.deload)
        : { ...base.context.deload },
    },
    behavior: {
      alert: toAlertMode(rawBehavior.alert),
      countdown3: toBool(rawBehavior.countdown3, DEFAULT_BEHAVIOR.countdown3),
      countUp: toBool(rawBehavior.countUp, DEFAULT_BEHAVIOR.countUp),
      awake: toBool(rawBehavior.awake, DEFAULT_BEHAVIOR.awake),
      skipWarmups: toBool(rawBehavior.skipWarmups, DEFAULT_BEHAVIOR.skipWarmups),
    },
  };
}
