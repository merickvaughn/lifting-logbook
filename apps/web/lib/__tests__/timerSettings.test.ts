import { TIMER_PRESET_DEFAULTS } from '@lifting-logbook/core';
import type { TimerRunState, TimerWorkoutKey } from '@lifting-logbook/core';
import {
  TIMER_RUN_SHAPE,
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
    on: { liftIndex: 0, setOrdinal: 1, kind: 'set' },
    startedAt: 1_700_000_000_000,
    pausedMs: 0,
    pausedAt: null,
    bonus: 0,
    workout: WORKOUT,
    classifications: {},
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
    // The anchor is what a rebuilt queue re-derives `idx` from (#980); without a
    // valid one the run cannot be placed.
    ['no anchor', { ...makeRun(), on: undefined }],
    ['a malformed anchor', { ...makeRun(), on: { liftIndex: 0, setOrdinal: 0 } }],
    ['an anchor of an unknown kind', { ...makeRun(), on: { liftIndex: 0, setOrdinal: 0, kind: 'cooldown' } }],
  ])('rejects a persisted run with %s', (_label, run) => {
    // `runShape` is written deliberately: without it `loadTimerRun` would bail on
    // the shape-version check before `isRunShape` ever ran, and every case here
    // would pass even if the field validation were deleted.
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({ settings: null, run, runShape: TIMER_RUN_SHAPE }),
    );
    expect(loadTimerRun(WORKOUT)).toBeNull();
  });

  it('accepts a paused run', () => {
    saveTimerRun(makeRun({ pausedAt: 1_700_000_030_000, pausedMs: 5_000 }));
    expect(loadTimerRun(WORKOUT)?.pausedAt).toBe(1_700_000_030_000);
  });

  // --- Queue-shape versioning (#960) ---------------------------------------

  it('drops a run recorded against an older queue shape', () => {
    // Exactly the blob a browser holds from before the activation phase existed:
    // a structurally valid run for this workout, with no `runShape`. Its `idx`
    // now addresses a different phase, and `startedAt` would be applied to that
    // phase's duration — a silently wrong countdown rather than a visible one.
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({ settings: null, run: makeRun() }),
    );
    expect(loadTimerRun(WORKOUT)).toBeNull();
  });

  it('drops a run stamped with a different shape version', () => {
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({ settings: null, run: makeRun(), runShape: TIMER_RUN_SHAPE - 1 }),
    );
    expect(loadTimerRun(WORKOUT)).toBeNull();
  });

  it('stamps the current shape when it writes a run', () => {
    saveTimerRun(makeRun());
    const raw: unknown = JSON.parse(window.localStorage.getItem(TIMER_STORAGE_KEY) ?? '{}');
    expect(raw).toMatchObject({ runShape: TIMER_RUN_SHAPE });
    expect(loadTimerRun(WORKOUT)?.idx).toBe(2);
  });

  it('keeps the run resumable across a settings write', () => {
    // `saveTimerSettings` rewrites the whole blob, so it has to carry `runShape`
    // forward — dropping it would silently end every session the moment the
    // lifter changed a duration on the Settings tab.
    saveTimerRun(makeRun());
    saveTimerSettings(loadTimerSettings());
    expect(loadTimerRun(WORKOUT)?.idx).toBe(2);
  });
});

// Issue #966: the timer page and the workout-detail dock each resolve a custom
// lift's classification independently, so the same in-flight rest could end at
// a different time on each surface. `classifications` pins the answer a run
// started with so a later `loadTimerRun` — on either route — hands back the
// same map rather than letting the reapplying route re-resolve it.
describe('run persistence — classifications', () => {
  it('round-trips a classifications map for the same workout', () => {
    saveTimerRun(makeRun({ classifications: { 'Cable Curls': 'accessory' } }));
    expect(loadTimerRun(WORKOUT)?.classifications).toEqual({ 'Cable Curls': 'accessory' });
  });

  // A run persisted by a build before this field existed has no `classifications`
  // key at all — it must still restore (losing only the pinning this field adds,
  // not the run itself), the same graceful-degrade contract `loadTimerSettings`
  // already gives the settings half of this blob.
  // These three carry `runShape` deliberately. Their subject is the
  // `classifications` field's leniency (#966), not queue-shape versioning
  // (#960) — and without the stamp `loadTimerRun` would drop each blob before
  // `normalizeClassifications` ever ran, so they would pass for a reason that
  // has nothing to do with what they assert. The two guarantees compose rather
  // than conflict: a run *stamped* for this queue shape but missing or
  // malformed `classifications` still restores, exactly as #966 intends.
  it('defaults to an empty map for a run persisted without this field', () => {
    // A structurally valid run for the current shape (it carries `on`) that
    // simply has no `classifications` — the field stays lenient.
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({
        settings: null,
        run: {
          idx: 3,
          on: { liftIndex: 0, setOrdinal: 1, kind: 'prep' },
          startedAt: 1,
          pausedMs: 0,
          pausedAt: null,
          bonus: 0,
          workout: WORKOUT,
        },
        runShape: TIMER_RUN_SHAPE,
      }),
    );

    const run = loadTimerRun(WORKOUT);
    expect(run).not.toBeNull();
    expect(run?.classifications).toEqual({});
  });

  it('degrades a malformed classifications value to an empty map rather than rejecting the run', () => {
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({
        settings: null,
        run: { ...makeRun(), classifications: 'not a map' },
        runShape: TIMER_RUN_SHAPE,
      }),
    );

    const run = loadTimerRun(WORKOUT);
    expect(run).not.toBeNull();
    expect(run?.classifications).toEqual({});
  });

  it('drops an invalid classification value while keeping the valid entries', () => {
    window.localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({
        settings: null,
        run: {
          ...makeRun(),
          // 'push' is not a real LiftClassification.
          classifications: { 'Cable Curls': 'accessory', 'Overhead Press': 'push' },
        },
        runShape: TIMER_RUN_SHAPE,
      }),
    );

    expect(loadTimerRun(WORKOUT)?.classifications).toEqual({ 'Cable Curls': 'accessory' });
  });

  // The end-to-end version of the fix: a pinned "no opinion" must survive the
  // real `saveTimerRun` -> `localStorage` -> `loadTimerRun` round trip through
  // this module, not just the pure `normalizeClassifications` function
  // (covered at the core-package level). `null`, not `undefined`, is what
  // makes that possible — `JSON.stringify` drops an `undefined`-valued key but
  // keeps a `null`-valued one, so the pin stays distinguishable from "never
  // pinned" (key absent) on the other side of the round trip.
  it('round-trips a pinned "no opinion" (null) through save and load', () => {
    saveTimerRun(makeRun({ classifications: { 'Cable Curls': null } }));

    const run = loadTimerRun(WORKOUT);
    expect(Object.prototype.hasOwnProperty.call(run?.classifications, 'Cable Curls')).toBe(true);
    expect(run?.classifications['Cable Curls']).toBeNull();
  });
});

describe('sameWorkout', () => {
  it('compares all three identifiers', () => {
    expect(sameWorkout(WORKOUT, { ...WORKOUT })).toBe(true);
    expect(sameWorkout(WORKOUT, { ...WORKOUT, workoutNum: 9 })).toBe(false);
  });
});
