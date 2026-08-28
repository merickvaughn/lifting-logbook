import {
  STANDARD_DURATIONS,
  TIMER_PRESET_DEFAULTS,
  defaultTimerSettings,
  normalizeTimerSettings,
  resolveDuration,
} from '@src/core';

describe('resolveDuration', () => {
  it('falls back to the active preset when nothing overrides it', () => {
    const s = defaultTimerSettings();
    expect(resolveDuration(s, 'Bench Press', 'restWork')).toBe(240);
  });

  it('reads from the selected preset, not always Standard', () => {
    const s = defaultTimerSettings();
    s.preset = 'Heavy day';
    expect(resolveDuration(s, 'Bench Press', 'restWork')).toBe(300);
  });

  it('prefers a per-lift override over the preset', () => {
    const s = defaultTimerSettings();
    s.overrides['Bench Press'] = { restWork: 420 };

    expect(resolveDuration(s, 'Bench Press', 'restWork')).toBe(420);
    expect(resolveDuration(s, 'Barbell Rows', 'restWork')).toBe(240);
  });

  it('prefers a per-lift override over the deload context', () => {
    const s = defaultTimerSettings();
    s.context.deloadOn = true;
    s.overrides['Bench Press'] = { restWork: 420 };

    expect(resolveDuration(s, 'Bench Press', 'restWork')).toBe(420);
  });

  it('applies the deload context only while the toggle is on', () => {
    const s = defaultTimerSettings();
    expect(resolveDuration(s, 'Bench Press', 'restWork')).toBe(240);

    s.context.deloadOn = true;
    expect(resolveDuration(s, 'Bench Press', 'restWork')).toBe(150);
  });

  it('falls through a deload context that does not set the field', () => {
    const s = defaultTimerSettings();
    s.context.deloadOn = true;
    s.context.deload = { workSet: 45 };

    expect(resolveDuration(s, 'Bench Press', 'restWork')).toBe(240);
    expect(resolveDuration(s, 'Bench Press', 'workSet')).toBe(45);
  });

  it('falls back to Standard when the active preset no longer exists', () => {
    const s = defaultTimerSettings();
    s.preset = 'Deleted preset';

    expect(resolveDuration(s, 'Bench Press', 'restWork')).toBe(
      STANDARD_DURATIONS.restWork,
    );
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
