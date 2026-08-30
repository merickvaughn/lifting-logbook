import type { LiftClassification } from '@lifting-logbook/types';
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
  Standard: { warmupSet: 30, workSet: 60, restWarmup: 90, restWork: 240, prep: 10, activation: 60 },
  'Heavy day': {
    warmupSet: 30,
    workSet: 60,
    restWarmup: 90,
    restWork: 300,
    prep: 15,
    activation: 60,
  },
  'Light day': {
    warmupSet: 30,
    workSet: 45,
    restWarmup: 60,
    restWork: 150,
    prep: 10,
    activation: 45,
  },
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

/**
 * Every duration field, in the order the settings UI renders them.
 *
 * `satisfies`, not a `readonly TimerDurationField[]` annotation: the annotation
 * widens the tuple, so a field added to {@link TimerDurationField} and forgotten
 * here would compile. That omission is silent and costly —
 * `normalizeTimerSettings` iterates this array to read a persisted blob, so a
 * missing field is never read back and the lifter's saved value reverts to the
 * shipped default on every load. The completeness assertion below is what turns
 * that into a compile error.
 */
export const TIMER_DURATION_FIELDS = [
  'warmupSet',
  'workSet',
  'restWarmup',
  'restWork',
  'prep',
  'activation',
] as const satisfies readonly TimerDurationField[];

/**
 * Compile-time proof that {@link TIMER_DURATION_FIELDS} lists every field.
 *
 * `satisfies` above proves every listed member is a valid field; this proves the
 * converse. Unused at runtime by design — it exists to fail `tsc`.
 *
 * The tuple wrappers are load-bearing. A bare `Missing extends never ? …` is a
 * *distributive* conditional, and distributing over `never` yields `never` — so
 * the healthy case would resolve to `never`, reject the `true`, and fail
 * permanently. `[Missing] extends [never]` suppresses distribution and gives the
 * intended `true`/`false`. Verified in both directions: adding a seventh field to
 * `TimerDurationField` without listing it here fails this line.
 */
type _MissingDurationFields = Exclude<
  TimerDurationField,
  (typeof TIMER_DURATION_FIELDS)[number]
>;
const _durationFieldsAreExhaustive: [_MissingDurationFields] extends [never] ? true : false = true;
void _durationFieldsAreExhaustive;

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
  activation: {
    label: 'Activation',
    hint: 'Runs once before each lift that has an activation movement',
    step: 15,
  },
};

const DEFAULT_BEHAVIOR: TimerBehavior = {
  alert: 'Both',
  countdown3: true,
  countUp: true,
  awake: true,
  skipWarmups: false,
};

/**
 * Accessory-lift durations, applied while `context.accessoryOn` is set.
 *
 * Same spirit as {@link SHIPPED_PRESETS}: numbers a lifter can reason about
 * rather than tuned constants — 90 s is the conventional accessory rest and 45 s
 * matches "Light day" under the bar. Both are editable in the settings panel, so
 * this is only where the chain starts.
 *
 * Only `workSet` and `restWork` are set. Warm-ups, the between-warm-up rest, and
 * the setup countdown are unaffected by whether a lift is an accessory, and a
 * field left unset here falls through to the preset rather than being pinned.
 */
const DEFAULT_ACCESSORY_DURATIONS: Partial<TimerPresetDurations> = { workSet: 45, restWork: 90 };

/** A fresh settings blob — what a first-time user, or a corrupt blob, resolves to. */
export function defaultTimerSettings(): TimerSettings {
  return {
    preset: 'Standard',
    presets: structuredCloneish(TIMER_PRESET_DEFAULTS),
    overrides: {},
    context: {
      deloadOn: false,
      deload: { workSet: 60, restWork: 150 },
      // On by default, unlike `deloadOn`: a deload is an occasional week the
      // lifter enters deliberately, whereas "an accessory gets shorter rest" is
      // the standing rule this context exists to express. Resting four minutes
      // between curls — what the preset alone produces — is the behavior worth
      // changing, and the toggle is one tap away for anyone who disagrees.
      accessoryOn: true,
      accessory: { ...DEFAULT_ACCESSORY_DURATIONS },
    },
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
 * The resolved duration alone — see {@link resolveDurationEntry}, which this
 * delegates to and which documents the precedence chain.
 *
 * Kept as a separate export because the queue builder only ever wants the number;
 * `resolveDurationEntry(...).seconds` at all three of its call sites would be
 * noise for a caller that has no use for the rung.
 */
export function resolveDuration(
  settings: TimerSettings,
  lift: string,
  field: TimerDurationField,
  classification: LiftClassification | undefined,
): number {
  return resolveDurationEntry(settings, lift, field, classification).seconds;
}

/** Which rung of the chain supplied a duration. */
export type TimerDurationSource = 'override' | 'deload' | 'accessory' | 'preset' | 'standard';

/**
 * Resolves one duration for one lift, applying the precedence the settings UI
 * promises, and reports which rung supplied it:
 *
 * 1. a per-lift override,
 * 2. the deload context (when the deload toggle is on),
 * 3. the accessory context (when its toggle is on *and* this lift is an accessory),
 * 4. the active preset.
 *
 * Each rung is consulted per *field*, not per rung as a whole, so a context that
 * sets only `restWork` leaves `workSet` to fall through rather than pinning it.
 *
 * Falls back to `Standard` when `preset` names a preset that no longer exists —
 * a persisted blob can outlive a renamed preset, and a missing duration should
 * degrade to a sensible countdown rather than to zero.
 *
 * `classification` is a required parameter with no default, deliberately. An
 * optional one would let a call site silently opt out of the accessory rung by
 * omission — a change that breaks nothing at compile time and produces plausible
 * durations at runtime, which is the hardest kind of regression to notice. There
 * are only a handful of call sites; each is made to answer. Pass `undefined`
 * where the role genuinely is not known.
 *
 * The `source` exists so the settings panel can *say* what a lift follows rather
 * than assume it follows the preset. Sharing one implementation with
 * `resolveDuration` is what keeps the label and the countdown from disagreeing;
 * a panel-local copy of this precedence would be free to drift.
 *
 * Adding a fifth rung means touching seven places — this chain, `TimerDurationSource`,
 * `TimerContext`, `defaultTimerSettings`, `normalizeTimerSettings`, the panel's
 * `clone()`, and its `sourceLabel()` — of which only the union and `sourceLabel`
 * are compiler-enforced.
 */
export function resolveDurationEntry(
  settings: TimerSettings,
  lift: string,
  field: TimerDurationField,
  classification: LiftClassification | undefined,
): { seconds: number; source: TimerDurationSource } {
  const override = hasOwn(settings.overrides, lift) ? settings.overrides[lift]?.[field] : undefined;
  if (override != null) return { seconds: override, source: 'override' };

  if (settings.context.deloadOn) {
    const deload = settings.context.deload[field];
    if (deload != null) return { seconds: deload, source: 'deload' };
  }

  if (settings.context.accessoryOn && classification === 'accessory') {
    const accessory = settings.context.accessory[field];
    if (accessory != null) return { seconds: accessory, source: 'accessory' };
  }

  const preset = hasOwn(settings.presets, settings.preset)
    ? settings.presets[settings.preset]
    : undefined;
  const value = preset?.[field];
  if (value != null) return { seconds: value, source: 'preset' };

  return { seconds: STANDARD_DURATIONS[field], source: 'standard' };
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
    // Both context sections narrow through `toPartialDurations`, which reads only
    // the known TIMER_DURATION_FIELDS off the raw value — so unlike
    // `presets` and `overrides` above there is no `hasOwn` guard here, and none
    // is needed: these are fixed-key duration objects, not records keyed by a
    // user-supplied name, so no inherited Object.prototype member is ever
    // reachable as a key. A section that narrowed to nothing falls back to the
    // defaults rather than leaving a context that is on but sets no field.
    context: {
      deloadOn: toBool(rawContext.deloadOn, base.context.deloadOn),
      deload: Object.keys(toPartialDurations(rawContext.deload)).length
        ? toPartialDurations(rawContext.deload)
        : { ...base.context.deload },
      accessoryOn: toBool(rawContext.accessoryOn, base.context.accessoryOn),
      accessory: Object.keys(toPartialDurations(rawContext.accessory)).length
        ? toPartialDurations(rawContext.accessory)
        : { ...base.context.accessory },
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

/**
 * A stored classification: a known role, or `null` for a lift a run pinned
 * with no opinion. Distinct from `LiftClassification | undefined` — `undefined`
 * is never valid *stored* input; see the field doc on
 * `TimerRunState.classifications` for why the pinned map uses `null` where
 * `TimerLiftPlan.classification` itself uses `undefined`.
 */
function isStoredClassification(value: unknown): value is LiftClassification | null {
  return value === 'compound' || value === 'accessory' || value === null;
}

/**
 * Sanitizes a run's persisted `classifications` snapshot (see
 * `TimerRunState.classifications` in `./types`).
 *
 * Same contract as {@link normalizeTimerSettings}: a hand-edited, truncated, or
 * older-schema value — one persisted before this field existed — degrades to an
 * empty map rather than rejecting the run it belongs to. `applyClassifications`
 * already treats a lift absent from the map as "no pinned answer, resolve it
 * yourself", so `{}` is a meaningful default, not a loss of data: it reproduces
 * exactly the independent-resolution behavior every route had before this
 * field existed.
 *
 * Keeps a `null` value rather than dropping it: `null` is a *pinned* answer
 * ("no opinion", read back by `applyClassifications` as `undefined`), not a
 * malformed one — dropping it here would be indistinguishable from the lift
 * never having been pinned at all, and would reopen the disagreement pinning
 * exists to close for exactly the lift whose fetch degraded.
 *
 * Built on `Object.create(null)`, not `{}`, for the same reason
 * `snapshotClassifications` in `./queue` is: the keys are lift names, arbitrary
 * user input, and a literal `"__proto__"` must land as its own entry rather
 * than being read through, or silently reassigning, `Object.prototype`.
 */
export function normalizeClassifications(
  raw: unknown,
): Record<string, LiftClassification | null> {
  const out: Record<string, LiftClassification | null> = Object.create(null);
  if (!isRecord(raw)) return out;
  for (const [lift, value] of Object.entries(raw)) {
    if (isStoredClassification(value)) out[lift] = value;
  }
  return out;
}
