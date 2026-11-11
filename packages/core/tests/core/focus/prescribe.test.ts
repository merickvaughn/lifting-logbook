import type { FocusProgression } from '@lifting-logbook/types';
import { prescribe } from '@src/core';
import { entry } from './focusFixtures';

describe('prescribe', () => {
  const pool = entry('Lateral Raise', { repsLow: 12, repsHigh: 15, weight: 27.3, trainingMax: 95, percent: 65, rpe: 8.5 });

  it('double progression keeps the rep range, weight as entered, and last reps', () => {
    expect(prescribe({ progression: 'double' }, { ...pool, lastReps: [15, 14] }, 3, 2.5)).toEqual({
      progression: 'double',
      sets: 3,
      repsLow: 12,
      repsHigh: 15,
      weight: 27.3,
      lastReps: [15, 14],
      progressed: false,
    });
    expect(prescribe({ progression: 'double' }, pool, 3, 2.5)).toMatchObject({ lastReps: null, progressed: false });
    expect(prescribe({ progression: 'double' }, { ...pool, lastReps: [] }, 3, 2.5)).toMatchObject({
      weight: 27.3,
      progressed: false,
    });
  });

  it('double progression adds the increment once every last rep reached the top of the range (#1213)', () => {
    const topped = { ...pool, weight: 30, lastReps: [15, 15, 16] };
    expect(prescribe({ progression: 'double' }, topped, 3, 2.5)).toEqual({
      progression: 'double',
      sets: 3,
      repsLow: 12,
      repsHigh: 15,
      weight: 32.5,
      lastReps: [15, 15, 16],
      progressed: true,
    });
    expect(prescribe({ progression: 'double' }, topped, 3, 5)).toMatchObject({ weight: 35 });
  });

  // `manual` was `fixed` and `percent_wave` was `tm` before #1213: the same entry plans the
  // same sets, reps and weights under its new value.
  it('manual (was fixed) never rounds the entered weight', () => {
    expect(prescribe({ progression: 'manual' }, pool, 2, 2.5)).toEqual({ progression: 'manual', sets: 2, reps: 15, weight: 27.3 });
  });

  it('percent_wave (was tm) rounds a percent of training max to the configured plate increment', () => {
    // 65% of 95 = 61.75
    expect(prescribe({ progression: 'percent_wave' }, pool, 3, 2.5)).toEqual({
      progression: 'percent_wave',
      sets: 3,
      reps: 15,
      weight: 62.5,
      percent: 65,
      trainingMax: 95,
    });
    expect(prescribe({ progression: 'percent_wave' }, pool, 3, 5)).toMatchObject({ weight: 60 });
    expect(prescribe({ progression: 'percent_wave' }, pool, 3, 1.25)).toMatchObject({ weight: 61.25 });
  });

  it('RPE reports reps in reserve', () => {
    expect(prescribe({ progression: 'rpe' }, pool, 4, 2.5)).toEqual({
      progression: 'rpe',
      sets: 4,
      reps: 15,
      rpe: 8.5,
      repsInReserve: 1.5,
    });
  });

  it('throws on a progression it does not know', () => {
    expect(() => prescribe({ progression: 'tm' as FocusProgression }, pool, 3, 2.5)).toThrow(
      'Unknown focus progression: tm',
    );
  });
});
