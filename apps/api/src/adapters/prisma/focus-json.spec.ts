import { DEFAULT_FOCUS_TIMER, emptyFocusDayState } from '@lifting-logbook/types';
import { parseFocusDayState, parseFocusPool, parseFocusTimer } from './focus-json';

describe('focus JSON read guards', () => {
  it('keeps the rest of a day state when only its placement is unreadable', () => {
    const state = parseFocusDayState({
      modes: { b1: 'pick', b2: 'sometimes' },
      picks: { b1: ['Hammer Curl'] },
      trims: { b1: ['Cable Curl'], b2: [1] },
      placement: 'retired-value',
      order: ['a', 'b'],
      dismissed: true,
    });
    expect(state).toEqual({
      modes: { b1: 'pick' },
      picks: { b1: ['Hammer Curl'] },
      trims: { b1: ['Cable Curl'] },
      placement: 'after',
      order: ['a', 'b'],
      dismissed: true,
    });
  });

  it('reads a non-object as the empty state, a fresh one each time', () => {
    const first = parseFocusDayState('garbage');
    expect(first).toEqual(emptyFocusDayState());
    first.trims.x = ['mutated'];
    expect(parseFocusDayState(null).trims).toEqual({});
  });

  it('drops pool entries that no longer read as entries, keeping the rest', () => {
    const good = {
      lift: 'Hammer Curl',
      include: 'auto',
      ruleLift: '',
      swapTo: '',
      sets: 3,
      repsLow: 10,
      repsHigh: 12,
      weight: 25,
      trainingMax: 40,
      percent: 65,
      rpe: 8,
    };
    expect(parseFocusPool([good, { ...good, include: 'never' }, 'x'])).toEqual([good]);
    expect(parseFocusPool({ not: 'an array' })).toEqual([]);
  });

  it('falls back to the default timer when the stored one is unreadable', () => {
    expect(parseFocusTimer({ prep: 5, set: 30, rest: 40 })).toEqual({ prep: 5, set: 30, rest: 40 });
    expect(parseFocusTimer({ prep: -1, set: 30, rest: 40 })).toEqual(DEFAULT_FOCUS_TIMER);
  });
});
