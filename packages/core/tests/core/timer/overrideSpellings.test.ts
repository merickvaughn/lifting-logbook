import { defaultTimerSettings, resolveDurationEntry, timerOverrideKey, type TimerSettings } from '@src/core';

function withOverride(lift: string, restWork: number): TimerSettings {
  const settings = defaultTimerSettings();
  settings.overrides[lift] = { restWork };
  return settings;
}

// #1135: timer overrides are stored by lift name, and the plan can spell it another way.
describe('timer overrides across stored spellings', () => {
  it('applies an override under bench-press to Bench Press', () => {
    expect(resolveDurationEntry(withOverride('bench-press', 111), 'Bench Press', 'restWork', undefined)).toEqual({
      seconds: 111,
      source: 'override',
    });
  });

  it('applies an override under Bench Press to bench-press', () => {
    expect(resolveDurationEntry(withOverride('Bench Press', 111), 'bench-press', 'restWork', undefined)).toEqual({
      seconds: 111,
      source: 'override',
    });
  });

  it('prefers the exact name', () => {
    const settings = withOverride('bench-press', 111);
    settings.overrides['Bench Press'] = { restWork: 222 };
    expect(resolveDurationEntry(settings, 'Bench Press', 'restWork', undefined).seconds).toBe(222);
  });

  it('keeps two names apart, since a program can plan them as separate slots', () => {
    const settings = withOverride('C. Lat Raise', 111);
    expect(resolveDurationEntry(settings, 'Lateral Raise', 'restWork', undefined).source).not.toBe('override');
  });

  it('names the key holding the overrides, or the lift when none does', () => {
    expect(timerOverrideKey(withOverride('bench-press', 111), 'Bench Press')).toBe('bench-press');
    expect(timerOverrideKey(defaultTimerSettings(), 'Bench Press')).toBe('Bench Press');
  });

  it('is not fooled by a name on Object.prototype', () => {
    expect(timerOverrideKey(defaultTimerSettings(), 'toString')).toBe('toString');
    expect(resolveDurationEntry(defaultTimerSettings(), 'toString', 'restWork', undefined).source).not.toBe('override');
  });
});
