import { TIMER_PRESET_DEFAULTS } from '@lifting-logbook/core';
import type { TimerRunState, TimerWorkoutKey } from '@lifting-logbook/core';
import {
  TIMER_STORAGE_KEY,
  loadTimerRun,
  loadTimerSettings,
  sameWorkout,
  saveTimerRun,
  saveTimerSettings,
} from '../timerSettings';

const WORKOUT: TimerWorkoutKey = { program: '531', cycleNum: 1, workoutNum: 3 };

function makeRun(overrides: Partial<TimerRunState> = {}): TimerRunState {
  return {
    idx: 2,
    startedAt: 1_700_000_000_000,
    pausedMs: 0,
    pausedAt: null,
    bonus: 0,
    workout: WORKOUT,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('loadTimerSettings', () => {
  it('returns defaults when nothing is stored', () => {
    const settings = loadTimerSettings();
    expect(settings.preset).toBe('Standard');
    expect(settings.presets.Standard).toEqual(TIMER_PRESET_DEFAULTS.Standard);
  });

  it('round-trips through saveTimerSettings', () => {
    const settings = loadTimerSettings();
    settings.preset = 'Heavy day';
    settings.overrides['Bench Press'] = { restWork: 420 };
    settings.behavior.alert = 'Silent';

    saveTimerSettings(settings);

    const reloaded = loadTimerSettings();
    expect(reloaded.preset).toBe('Heavy day');
    expect(reloaded.overrides['Bench Press']).toEqual({ restWork: 420 });
    expect(reloaded.behavior.alert).toBe('Silent');
  });

  it('falls back to defaults on corrupt JSON rather than throwing', () => {
    window.localStorage.setItem(TIMER_STORAGE_KEY, '{not json');
    expect(loadTimerSettings().preset).toBe('Standard');
  });

  it('falls back to defaults when the blob is not an object', () => {
    window.localStorage.setItem(TIMER_STORAGE_KEY, '"a string"');
    expect(loadTimerSettings().preset).toBe('Standard');
  });

  it('repairs a partially-written blob instead of surfacing holes', () => {
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({ settings: { presets: { Standard: { workSet: 90 } } } }),
    );

    const settings = loadTimerSettings();
    expect(settings.presets.Standard?.workSet).toBe(90);
    expect(settings.presets.Standard?.restWork).toBe(TIMER_PRESET_DEFAULTS.Standard?.restWork);
  });

  it('survives a storage write that throws', () => {
    const setItem = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });

    // Fails open: the caller never sees the quota error, the value just isn't kept.
    expect(() => saveTimerSettings(loadTimerSettings())).not.toThrow();
    expect(setItem).toHaveBeenCalled();

    setItem.mockRestore();
  });

  it('survives a storage read that throws', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });

    expect(loadTimerSettings().preset).toBe('Standard');

    getItem.mockRestore();
  });
});

describe('run persistence', () => {
  it('round-trips a run for the same workout', () => {
    saveTimerRun(makeRun());
    expect(loadTimerRun(WORKOUT)?.idx).toBe(2);
  });

  it('does not restore a run belonging to a different workout', () => {
    saveTimerRun(makeRun());

    expect(loadTimerRun({ ...WORKOUT, workoutNum: 4 })).toBeNull();
    expect(loadTimerRun({ ...WORKOUT, cycleNum: 2 })).toBeNull();
    expect(loadTimerRun({ ...WORKOUT, program: 'leangains' })).toBeNull();
  });

  it('clears the run when saved as null', () => {
    saveTimerRun(makeRun());
    saveTimerRun(null);
    expect(loadTimerRun(WORKOUT)).toBeNull();
  });

  it('preserves settings when the run changes, and vice versa', () => {
    const settings = loadTimerSettings();
    settings.preset = 'Light day';
    saveTimerSettings(settings);

    saveTimerRun(makeRun());
    expect(loadTimerSettings().preset).toBe('Light day');

    const updated = loadTimerSettings();
    updated.behavior.countUp = false;
    saveTimerSettings(updated);
    expect(loadTimerRun(WORKOUT)?.idx).toBe(2);
  });

  it.each([
    ['a missing workout key', { idx: 1, startedAt: 1, pausedMs: 0, pausedAt: null, bonus: 0 }],
    ['a non-numeric idx', { ...makeRun(), idx: 'two' }],
    ['a negative idx', { ...makeRun(), idx: -1 }],
    ['a NaN startedAt', { ...makeRun(), startedAt: Number.NaN }],
    ['a non-null non-numeric pausedAt', { ...makeRun(), pausedAt: 'yes' }],
    ['a malformed workout key', { ...makeRun(), workout: { program: '531' } }],
  ])('rejects a persisted run with %s', (_label, run) => {
    window.localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify({ settings: null, run }));
    expect(loadTimerRun(WORKOUT)).toBeNull();
  });

  it('accepts a paused run', () => {
    saveTimerRun(makeRun({ pausedAt: 1_700_000_030_000, pausedMs: 5_000 }));
    expect(loadTimerRun(WORKOUT)?.pausedAt).toBe(1_700_000_030_000);
  });
});

describe('sameWorkout', () => {
  it('compares all three identifiers', () => {
    expect(sameWorkout(WORKOUT, { ...WORKOUT })).toBe(true);
    expect(sameWorkout(WORKOUT, { ...WORKOUT, workoutNum: 9 })).toBe(false);
  });
});
