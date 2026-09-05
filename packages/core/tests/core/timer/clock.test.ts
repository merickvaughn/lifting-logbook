import {
  elapsedSeconds,
  formatDuration,
  parseDuration,
  phaseDuration,
  phaseProgress,
  phaseRemaining,
} from '@src/core';
import type { TimerPhase, TimerRunState } from '@src/core';

const T0 = 1_700_000_000_000;

function run(overrides: Partial<TimerRunState> = {}): TimerRunState {
  return {
    idx: 0,
    on: { liftIndex: 0, setOrdinal: 0, kind: 'rest' },
    startedAt: T0,
    pausedMs: 0,
    pausedAt: null,
    bonus: 0,
    workout: { program: 'p', cycleNum: 1, workoutNum: 1 },
    classifications: {},
    ...overrides,
  };
}

function phase(overrides: Partial<TimerPhase> = {}): TimerPhase {
  return {
    kind: 'rest',
    label: 'Rest',
    dur: 240,
    lift: 'Bench Press',
    set: { type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' },
    setIndex: 0,
    liftIndex: 0,
    setOrdinal: 0,
    next: null,
    ...overrides,
  };
}

describe('elapsedSeconds', () => {
  it('is a wall-clock subtraction, not a sum of ticks', () => {
    // The interval never fires here — only the clock moves. This is the
    // behaviour that keeps the countdown honest in a throttled background tab.
    expect(elapsedSeconds(run(), T0 + 90_000)).toBe(90);
    expect(elapsedSeconds(run(), T0 + 3_600_000)).toBe(3600);
  });

  it('is zero at the moment the phase starts', () => {
    expect(elapsedSeconds(run(), T0)).toBe(0);
  });

  it('never goes negative when the clock reads before startedAt', () => {
    expect(elapsedSeconds(run(), T0 - 5_000)).toBe(0);
  });

  it('freezes while paused', () => {
    const paused = run({ pausedAt: T0 + 30_000 });

    expect(elapsedSeconds(paused, T0 + 30_000)).toBe(30);
    expect(elapsedSeconds(paused, T0 + 600_000)).toBe(30);
  });

  it('excludes accumulated paused time after resuming', () => {
    // Started, ran 30s, paused 20s, resumed. At T0+80s, 60s has actually elapsed.
    const resumed = run({ pausedMs: 20_000 });
    expect(elapsedSeconds(resumed, T0 + 80_000)).toBe(60);
  });

  it('excludes multiple pauses', () => {
    const resumed = run({ pausedMs: 45_000 });
    expect(elapsedSeconds(resumed, T0 + 105_000)).toBe(60);
  });
});

describe('phaseDuration', () => {
  it('adds the nudge to a rest phase', () => {
    expect(phaseDuration(phase(), run({ bonus: 30 }))).toBe(270);
    expect(phaseDuration(phase(), run({ bonus: -30 }))).toBe(210);
  });

  it('ignores the nudge on prep and set phases', () => {
    expect(phaseDuration(phase({ kind: 'set', dur: 60 }), run({ bonus: 30 }))).toBe(60);
    expect(phaseDuration(phase({ kind: 'prep', dur: 10 }), run({ bonus: 30 }))).toBe(10);
  });

  it('floors a nudged rest at zero rather than going negative', () => {
    expect(phaseDuration(phase({ dur: 20 }), run({ bonus: -60 }))).toBe(0);
  });
});

describe('phaseRemaining', () => {
  it('counts down', () => {
    expect(phaseRemaining(phase(), run(), T0 + 40_000)).toBe(200);
  });

  it('goes negative on overrun — a real state, not an error', () => {
    expect(phaseRemaining(phase(), run(), T0 + 250_000)).toBe(-10);
  });
});

describe('phaseProgress', () => {
  it('runs 0 to 1 across the phase', () => {
    expect(phaseProgress(phase(), run(), T0)).toBe(0);
    expect(phaseProgress(phase(), run(), T0 + 120_000)).toBe(0.5);
    expect(phaseProgress(phase(), run(), T0 + 240_000)).toBe(1);
  });

  it('pins to 1 on overrun instead of wrapping', () => {
    expect(phaseProgress(phase(), run(), T0 + 999_000)).toBe(1);
  });

  it('returns 1 for a zero-length phase rather than dividing by zero', () => {
    const result = phaseProgress(phase({ dur: 0 }), run(), T0 + 1_000);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(1);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [60, '1:00'],
    [95, '1:35'],
    [240, '4:00'],
    [3599, '59:59'],
    [3600, '60:00'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it('takes the absolute value so the caller owns the sign', () => {
    expect(formatDuration(-10)).toBe('0:10');
    expect(formatDuration(-243)).toBe('4:03');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(59.4)).toBe('0:59');
    expect(formatDuration(59.6)).toBe('1:00');
  });
});

describe('parseDuration', () => {
  it.each([
    ['4:00', 240],
    ['0:45', 45],
    ['1:05', 65],
    ['90', 90],
    ['0', 0],
    ['  2:30  ', 150],
  ])('parses %s as %i seconds', (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });

  it('round-trips through formatDuration', () => {
    for (const seconds of [0, 9, 60, 95, 240, 3599]) {
      expect(parseDuration(formatDuration(seconds))).toBe(seconds);
    }
  });

  it('returns null for unparseable input so the caller keeps the old value', () => {
    for (const text of ['', '   ', 'abc', '1:2:3', '-30', '1.5', '4:xx']) {
      expect(parseDuration(text)).toBeNull();
    }
  });

  // `Number` accepts far more than the docstring promises. Each of these used to
  // parse: '0x10' as 16, '1e3' as 1000, '+5' as 5, ':' and '4:' via an empty
  // component coercing to 0. The exponent form was the one that mattered — a
  // typed '1e21' reached storage as a phase that never ends.
  it.each(['0x10', '0b11', '0o17', '1e3', '1e21', '+5', ':', '4:', ':30', ' 4 : 3 0 '])(
    'rejects the non-decimal numeric form %p',
    (text) => {
      expect(parseDuration(text)).toBeNull();
    },
  );
});
