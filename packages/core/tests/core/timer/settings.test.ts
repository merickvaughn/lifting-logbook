import {
  MAX_TIMER_DURATION_SECONDS,
  STANDARD_DURATIONS,
  TIMER_DURATION_FIELDS,
  TIMER_PRESET_DEFAULTS,
  defaultTimerSettings,
  normalizeClassifications,
  normalizeTimerSettings,
  resolveDuration,
  resolveDurationEntry,
} from '@src/core';

describe('resolveDuration', () => {
  it('falls back to the active preset when nothing overrides it', () => {
    const s = defaultTimerSettings();
    expect(resolveDuration(s, 'Bench Press', 'restWork', undefined)).toBe(240);
  });

  it('reads from the selected preset, not always Standard', () => {
    const s = defaultTimerSettings();
    s.preset = 'Heavy day';
    expect(resolveDuration(s, 'Bench Press', 'restWork', undefined)).toBe(300);
  });

  it('prefers a per-lift override over the preset', () => {
    const s = defaultTimerSettings();
    s.overrides['Bench Press'] = { restWork: 420 };

    expect(resolveDuration(s, 'Bench Press', 'restWork', undefined)).toBe(420);
    expect(resolveDuration(s, 'Barbell Rows', 'restWork', undefined)).toBe(240);
  });

  it('prefers a per-lift override over the deload context', () => {
    const s = defaultTimerSettings();
    s.context.deloadOn = true;
    s.overrides['Bench Press'] = { restWork: 420 };

    expect(resolveDuration(s, 'Bench Press', 'restWork', undefined)).toBe(420);
  });

  it('applies the deload context only while the toggle is on', () => {
    const s = defaultTimerSettings();
    expect(resolveDuration(s, 'Bench Press', 'restWork', undefined)).toBe(240);

    s.context.deloadOn = true;
    expect(resolveDuration(s, 'Bench Press', 'restWork', undefined)).toBe(150);
  });

  it('falls through a deload context that does not set the field', () => {
    const s = defaultTimerSettings();
    s.context.deloadOn = true;
    s.context.deload = { workSet: 45 };

    expect(resolveDuration(s, 'Bench Press', 'restWork', undefined)).toBe(240);
    expect(resolveDuration(s, 'Bench Press', 'workSet', undefined)).toBe(45);
  });

  it('resolves the activation duration through the whole chain (#960)', () => {
    const s = defaultTimerSettings();
    // 4. the active preset
    expect(resolveDuration(s, 'Squat', 'activation', undefined)).toBe(
      STANDARD_DURATIONS.activation,
    );

    // 3. the accessory context does NOT pin activation by default — it ships only
    //    `workSet` and `restWork`, so an accessory's activation still falls
    //    through to the preset rather than inheriting a shortened rest.
    expect(resolveDuration(s, 'Cable Curl', 'activation', 'accessory')).toBe(
      STANDARD_DURATIONS.activation,
    );
    s.context.accessory.activation = 20;
    expect(resolveDuration(s, 'Cable Curl', 'activation', 'accessory')).toBe(20);
    // …and once set it stays scoped to accessories.
    expect(resolveDuration(s, 'Squat', 'activation', 'compound')).toBe(
      STANDARD_DURATIONS.activation,
    );

    // 2. the deload context outranks accessory
    s.context.deloadOn = true;
    s.context.deload.activation = 30;
    expect(resolveDuration(s, 'Cable Curl', 'activation', 'accessory')).toBe(30);

    // 1. a per-lift override beats every context
    s.overrides['Cable Curl'] = { activation: 90 };
    expect(resolveDuration(s, 'Cable Curl', 'activation', 'accessory')).toBe(90);
    expect(resolveDuration(s, 'Squat', 'activation', 'compound')).toBe(30);

    // 5. and a stale preset name still degrades to Standard, not to zero
    const stale = defaultTimerSettings();
    stale.preset = 'Deleted preset';
    expect(resolveDuration(stale, 'Squat', 'activation', undefined)).toBe(
      STANDARD_DURATIONS.activation,
    );
  });

  it('falls back to Standard when the active preset no longer exists', () => {
    const s = defaultTimerSettings();
    s.preset = 'Deleted preset';

    expect(resolveDuration(s, 'Bench Press', 'restWork', undefined)).toBe(
      STANDARD_DURATIONS.restWork,
    );
  });
});

describe('resolveDuration — the accessory context', () => {
  it('shortens an accessory lift and leaves everything else on the preset', () => {
    const s = defaultTimerSettings();

    // The same settings object, the same field, three different lifts: only the
    // accessory moves. A single-lift assertion would pass just as well against a
    // rung wired to fire for every lift.
    expect(resolveDuration(s, 'Cable Curls', 'restWork', 'accessory')).toBe(90);
    expect(resolveDuration(s, 'Bench Press', 'restWork', 'compound')).toBe(240);
    expect(resolveDuration(s, 'Some Unknown Lift', 'restWork', undefined)).toBe(240);
  });

  it('applies only while the accessory toggle is on', () => {
    const s = defaultTimerSettings();
    expect(resolveDuration(s, 'Cable Curls', 'restWork', 'accessory')).toBe(90);

    s.context.accessoryOn = false;
    expect(resolveDuration(s, 'Cable Curls', 'restWork', 'accessory')).toBe(240);
  });

  it('loses to a per-lift override', () => {
    const s = defaultTimerSettings();
    s.overrides['Cable Curls'] = { restWork: 420 };

    expect(resolveDuration(s, 'Cable Curls', 'restWork', 'accessory')).toBe(420);
  });

  it('loses to the deload context', () => {
    const s = defaultTimerSettings();
    s.context.deloadOn = true;

    // Deload is the narrower, deliberately-entered state, so a deload week
    // overrides the standing accessory rule rather than the other way round.
    expect(resolveDuration(s, 'Cable Curls', 'restWork', 'accessory')).toBe(150);
  });

  it('is reached when a deload week is on but does not set the field', () => {
    const s = defaultTimerSettings();
    s.context.deloadOn = true;
    s.context.deload = { workSet: 45 };

    // Per-field fall-through, not per-rung: deload claims workSet, accessory
    // still gets to claim restWork.
    expect(resolveDuration(s, 'Cable Curls', 'workSet', 'accessory')).toBe(45);
    expect(resolveDuration(s, 'Cable Curls', 'restWork', 'accessory')).toBe(90);
  });

  it('falls through a field the accessory context does not set', () => {
    const s = defaultTimerSettings();
    // Values chosen to collide with nothing in the Standard preset. The shipped
    // default accessory restWork is 90, which is also the preset's restWarmup —
    // so with the defaults, a bug that applied the accessory restWork to *every*
    // field would still produce 90 for restWarmup and this test would pass.
    s.context.accessory = { workSet: 41, restWork: 91 };

    // The accessory context sets workSet and restWork only — warm-ups, the
    // between-warm-up rest and the setup countdown stay on the preset.
    expect(resolveDuration(s, 'Cable Curls', 'restWarmup', 'accessory')).toBe(90);
    expect(resolveDuration(s, 'Cable Curls', 'prep', 'accessory')).toBe(10);
    expect(resolveDuration(s, 'Cable Curls', 'warmupSet', 'accessory')).toBe(30);

    // ...and the two it does set still come from it.
    expect(resolveDuration(s, 'Cable Curls', 'workSet', 'accessory')).toBe(41);
    expect(resolveDuration(s, 'Cable Curls', 'restWork', 'accessory')).toBe(91);
  });

  it('is on by default', () => {
    expect(defaultTimerSettings().context.accessoryOn).toBe(true);
  });
});

describe('resolveDurationEntry', () => {
  it('names the rung each value came from', () => {
    const s = defaultTimerSettings();
    s.overrides['Bench Press'] = { restWork: 420 };

    expect(resolveDurationEntry(s, 'Bench Press', 'restWork', 'compound')).toEqual({
      seconds: 420,
      source: 'override',
    });
    expect(resolveDurationEntry(s, 'Cable Curls', 'restWork', 'accessory')).toEqual({
      seconds: 90,
      source: 'accessory',
    });
    expect(resolveDurationEntry(s, 'Cable Curls', 'restWork', 'compound')).toEqual({
      seconds: 240,
      source: 'preset',
    });

    s.context.deloadOn = true;
    expect(resolveDurationEntry(s, 'Cable Curls', 'restWork', 'accessory')).toEqual({
      seconds: 150,
      source: 'deload',
    });
  });

  it('reports the Standard fallback as its own source, not as the preset', () => {
    const s = defaultTimerSettings();
    s.preset = 'Deleted preset';

    // The panel labels a row with this source. Calling it 'preset' would have it
    // claim the lift follows a preset that no longer exists.
    expect(resolveDurationEntry(s, 'Bench Press', 'restWork', undefined)).toEqual({
      seconds: STANDARD_DURATIONS.restWork,
      source: 'standard',
    });
  });

  it('agrees with resolveDuration, which delegates to it', () => {
    const s = defaultTimerSettings();
    s.context.deloadOn = true;
    s.overrides.Squat = { workSet: 75 };

    for (const lift of ['Squat', 'Cable Curls', 'Bench Press']) {
      for (const field of TIMER_DURATION_FIELDS) {
        expect(resolveDuration(s, lift, field, 'accessory')).toBe(
          resolveDurationEntry(s, lift, field, 'accessory').seconds,
        );
      }
    }
  });
});

describe('normalizeTimerSettings', () => {
  it('returns defaults for a non-object', () => {
    for (const value of [null, undefined, 42, 'nope', []]) {
      expect(normalizeTimerSettings(value)).toEqual(defaultTimerSettings());
    }
  });

  it('preserves a valid persisted blob', () => {
    const original = defaultTimerSettings();
    original.preset = 'Light day';
    original.overrides['Bench Press'] = { restWork: 300 };
    original.behavior.alert = 'Vibrate';

    expect(normalizeTimerSettings(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  it('fills a partial preset field-by-field rather than leaving a hole', () => {
    const result = normalizeTimerSettings({
      preset: 'Standard',
      presets: { Standard: { workSet: 90 } },
    });

    expect(result.presets.Standard?.workSet).toBe(90);
    expect(result.presets.Standard?.restWork).toBe(STANDARD_DURATIONS.restWork);
  });

  it('fills the activation duration into a blob written before it existed (#960)', () => {
    // Exactly the shape a browser holds after #959: every pre-activation field
    // present, `activation` absent. Left as a hole it would resolve to undefined
    // inside the tick loop and render NaN.
    const preActivation = {
      preset: 'Light day',
      presets: {
        Standard: { warmupSet: 30, workSet: 60, restWarmup: 90, restWork: 240, prep: 10 },
        'Light day': { warmupSet: 30, workSet: 45, restWarmup: 60, restWork: 150, prep: 10 },
      },
      overrides: { 'Bench Press': { restWork: 300 } },
    };

    const result = normalizeTimerSettings(preActivation);

    expect(result.presets['Light day']?.activation).toBe(
      TIMER_PRESET_DEFAULTS['Light day']?.activation,
    );
    expect(result.presets.Standard?.activation).toBe(STANDARD_DURATIONS.activation);
    // The lifter's own edits survive alongside the filled-in default.
    expect(result.presets['Light day']?.restWork).toBe(150);
    expect(result.overrides['Bench Press']).toEqual({ restWork: 300 });
    expect(resolveDuration(result, 'Bench Press', 'activation', undefined)).toBeGreaterThan(0);
  });

  it('rejects non-numeric, negative, and non-finite durations', () => {
    const result = normalizeTimerSettings({
      presets: { Standard: { workSet: 'sixty', restWork: -1, prep: Infinity, warmupSet: NaN } },
    });

    expect(result.presets.Standard?.workSet).toBe(STANDARD_DURATIONS.workSet);
    expect(result.presets.Standard?.restWork).toBe(STANDARD_DURATIONS.restWork);
    expect(result.presets.Standard?.prep).toBe(STANDARD_DURATIONS.prep);
    expect(result.presets.Standard?.warmupSet).toBe(STANDARD_DURATIONS.warmupSet);
  });

  it('repoints preset at a real preset when it names a missing one', () => {
    const result = normalizeTimerSettings({
      preset: 'Ghost',
      presets: { Standard: STANDARD_DURATIONS },
    });

    expect(result.preset).toBe('Standard');
  });

  // 'Ghost' is not on Object.prototype, so the test above passed even while the
  // validation walked the prototype chain. These names are the ones that slipped
  // through: `presets['toString'] != null` is true for every object, so the bad
  // name was kept and resolved to a *function* — every duration rendered 0:00,
  // and a stepper edit wrote a property onto Object.prototype.
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'rejects the inherited Object.prototype member %p as a preset name',
    (name) => {
      const result = normalizeTimerSettings({
        preset: name,
        presets: { Standard: STANDARD_DURATIONS },
      });

      expect(result.preset).toBe('Standard');
      expect(typeof result.presets[result.preset]).toBe('object');
    },
  );

  it('does not write onto Object.prototype while normalizing a hostile blob', () => {
    normalizeTimerSettings(
      JSON.parse('{"presets":{"__proto__":{"workSet":1}},"overrides":{"__proto__":{"workSet":2}}}'),
    );

    expect(({} as Record<string, unknown>).workSet).toBeUndefined();
  });

  it('keeps an override for a lift named __proto__ across a serialization round trip', () => {
    // Built via JSON.parse, not an object literal: `{ __proto__: … }` in a
    // literal sets the prototype instead of creating an own key, so a literal
    // could not reproduce what a persisted blob actually carries.
    const raw: unknown = JSON.parse(
      JSON.stringify({ presets: { Standard: STANDARD_DURATIONS } }).replace(
        /}$/,
        ',"overrides":{"__proto__":{"workSet":99}}}',
      ),
    );

    const once = normalizeTimerSettings(raw);
    expect(resolveDuration(once, '__proto__', 'workSet', undefined)).toBe(99);

    // A plain `overrides[lift] = …` write would have survived in memory and then
    // serialized to `{}` — the override would vanish on the next reload.
    const reloaded = normalizeTimerSettings(JSON.parse(JSON.stringify(once)));
    expect(resolveDuration(reloaded, '__proto__', 'workSet', undefined)).toBe(99);
  });

  it('keeps a valid accessory context', () => {
    const result = normalizeTimerSettings({
      context: { accessoryOn: false, accessory: { workSet: 40, restWork: 75 } },
    });

    expect(result.context.accessoryOn).toBe(false);
    expect(result.context.accessory).toEqual({ workSet: 40, restWork: 75 });
  });

  it('rejects non-numeric, negative, and non-finite accessory durations', () => {
    const result = normalizeTimerSettings({
      context: { accessory: { workSet: 'quick', restWork: -1, prep: Infinity } },
    });

    // Every field narrowed away, so the section falls back to the defaults
    // rather than staying on but setting nothing.
    expect(result.context.accessory).toEqual(defaultTimerSettings().context.accessory);
  });

  it('defaults the accessory context when the blob predates it', () => {
    // A blob written by the build that shipped the timer has a context with
    // deload fields only — it must not normalize to an accessory section that is
    // switched on but empty, which would resolve nothing and read as a no-op.
    const base = defaultTimerSettings();
    const result = normalizeTimerSettings({
      preset: 'Standard',
      presets: { Standard: STANDARD_DURATIONS },
      context: { deloadOn: true, deload: { workSet: 60, restWork: 150 } },
    });

    expect(result.context.deloadOn).toBe(true);
    expect(result.context.accessoryOn).toBe(base.context.accessoryOn);
    expect(result.context.accessory).toEqual(base.context.accessory);
  });

  it('restores the default presets when the blob lost them entirely', () => {
    const result = normalizeTimerSettings({ preset: 'Standard', presets: {} });
    expect(Object.keys(result.presets).sort()).toEqual(
      Object.keys(TIMER_PRESET_DEFAULTS).sort(),
    );
  });

  it('drops an override that narrowed to nothing', () => {
    const result = normalizeTimerSettings({
      overrides: { 'Bench Press': { restWork: 'bad' }, Squat: { restWork: 300 } },
    });

    expect(result.overrides['Bench Press']).toBeUndefined();
    expect(result.overrides.Squat).toEqual({ restWork: 300 });
  });

  it('falls back on an unrecognised alert mode', () => {
    expect(normalizeTimerSettings({ behavior: { alert: 'Klaxon' } }).behavior.alert).toBe('Both');
    expect(normalizeTimerSettings({ behavior: { alert: 'Silent' } }).behavior.alert).toBe('Silent');
  });

  it('keeps behavior booleans that are present and defaults the rest', () => {
    const behavior = normalizeTimerSettings({
      behavior: { countUp: false, skipWarmups: 'yes' },
    }).behavior;

    expect(behavior.countUp).toBe(false);
    expect(behavior.skipWarmups).toBe(false);
    expect(behavior.countdown3).toBe(true);
  });

  it('does not share preset objects between two normalized results', () => {
    const a = normalizeTimerSettings({});
    const b = normalizeTimerSettings({});

    const preset = a.presets.Standard;
    expect(preset).toBeDefined();
    if (preset) preset.workSet = 999;

    // Editing one settings object must not reach another, nor the module-level
    // defaults every future load starts from.
    expect(b.presets.Standard?.workSet).toBe(STANDARD_DURATIONS.workSet);
    expect(STANDARD_DURATIONS.workSet).not.toBe(999);
  });
});

// Issue #966: `TimerRunState.classifications` pins each lift's classification
// when a run starts, so a later route rebuilding the queue reapplies that
// answer instead of resolving it fresh. This is the untrusted-blob half of that
// — the same always-degrades-to-usable contract `normalizeTimerSettings` gives
// the rest of `ll.timer.v1`, applied to a run persisted before this field
// existed, hand-edited, or truncated mid-write.
describe('normalizeClassifications', () => {
  it('returns an empty map for every non-object input', () => {
    for (const value of [null, undefined, 'string', 42, [], true]) {
      expect(normalizeClassifications(value)).toEqual({});
    }
  });

  it('keeps only valid classification values, including a pinned "no opinion"', () => {
    const result = normalizeClassifications({
      'Bench Press': 'compound',
      'Cable Curls': 'accessory',
      'Overhead Press': 'push', // not a LiftClassification
      Deadlift: 42,
      Row: null, // a pinned "no opinion" — valid, and distinct from the key being absent
    });

    expect(result).toEqual({
      'Bench Press': 'compound',
      'Cable Curls': 'accessory',
      Row: null,
    });
  });

  // The run schema predates this field — a run persisted by an older build (or
  // one degraded to `[]`/absent by `applyClassifications`'s own fallback) must
  // resolve to "no pinned answers" rather than rejecting the run it belongs to.
  it('defaults an absent value to an empty map', () => {
    expect(normalizeClassifications(undefined)).toEqual({});
  });

  // The behavior the whole `null`-not-`undefined` design rests on: `null`
  // survives a JSON round trip, so a pinned "no opinion" (key present, value
  // `null`) stays distinguishable from "never pinned" (key absent) — which is
  // exactly what lets a later route tell the two apart. See the field doc on
  // `TimerRunState.classifications`.
  it('keeps a pinned "no opinion" distinguishable from "never pinned" across a serialization round trip', () => {
    const pinned = normalizeClassifications({ 'Cable Curls': null });
    const reloaded = normalizeClassifications(JSON.parse(JSON.stringify(pinned)));

    expect(Object.prototype.hasOwnProperty.call(reloaded, 'Cable Curls')).toBe(true);
    expect(reloaded['Cable Curls']).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(reloaded, 'Bench Press')).toBe(false);
  });

  // A classification value is always one of two known strings (never an object),
  // so unlike `presets`/`overrides` — whose stored *values* are objects a hostile
  // `__proto__` key could use to reassign a prototype outright — the failure mode
  // here if this used a plain `{}` accumulator would be quieter: the
  // `Object.prototype.__proto__` setter silently no-ops for a non-object value,
  // so the entry would simply vanish rather than round-trip. That is exactly what
  // this test would catch.
  it('keeps a classification for a lift named __proto__ across a serialization round trip', () => {
    // Built via JSON.parse, not an object literal: `{ __proto__: … }` in a
    // literal sets the prototype instead of creating an own key, so a literal
    // could not reproduce what a persisted blob actually carries.
    const once = normalizeClassifications(JSON.parse('{"__proto__":"accessory"}'));
    expect(Object.prototype.hasOwnProperty.call(once, '__proto__')).toBe(true);
    expect(once['__proto__']).toBe('accessory');

    // A plain `out[lift] = …` write would have survived only in memory (if it
    // survived at all) and then serialized to `{}` — the entry would vanish on
    // the next reload.
    const reloaded = normalizeClassifications(JSON.parse(JSON.stringify(once)));
    expect(reloaded['__proto__']).toBe('accessory');
  });
});

// The UI cannot produce an out-of-range duration — DurationStepper.commit in
// TimerSettingsPanel.tsx clamps on input. These pin the clamp to the loading
// path itself, so a hand-edited or older-build `ll.timer.v1` blob degrades to
// the max instead of producing a multi-hour rest phase (#965). One case per
// section: the whole point of the fix is that the bound applies uniformly,
// not only to whichever section a prior fix happened to touch.
describe('normalizeTimerSettings — duration clamp (#965)', () => {
  const OUT_OF_RANGE = 86400;

  it('clamps an out-of-range preset duration to the max', () => {
    const result = normalizeTimerSettings({
      presets: { Standard: { restWork: OUT_OF_RANGE } },
    });

    expect(result.presets.Standard?.restWork).toBe(MAX_TIMER_DURATION_SECONDS);
  });

  it('clamps an out-of-range per-lift override duration to the max', () => {
    const result = normalizeTimerSettings({
      overrides: { 'Bench Press': { restWork: OUT_OF_RANGE } },
    });

    expect(result.overrides['Bench Press']).toEqual({ restWork: MAX_TIMER_DURATION_SECONDS });
  });

  it('clamps an out-of-range deload context duration to the max', () => {
    const result = normalizeTimerSettings({
      context: { deload: { restWork: OUT_OF_RANGE } },
    });

    expect(result.context.deload.restWork).toBe(MAX_TIMER_DURATION_SECONDS);
  });

  it('clamps an out-of-range accessory context duration to the max', () => {
    const result = normalizeTimerSettings({
      context: { accessory: { restWork: OUT_OF_RANGE } },
    });

    expect(result.context.accessory.restWork).toBe(MAX_TIMER_DURATION_SECONDS);
  });
});
