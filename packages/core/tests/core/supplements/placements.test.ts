import { hasAmount, isWorkoutSlot, placements, validateStack } from '@src/core';
import { DAILY_SLOTS, WORKOUT_SLOTS, type Ingredient } from '@lifting-logbook/types';
import { LIFT, REST, dose, ing, item } from './supplementFixtures';

describe('validateStack', () => {
  it('rejects a workout-slot dose with no day types', () => {
    const bad = item('a', { doses: [dose({ dayTypes: [] })] });
    expect(validateStack([bad], [LIFT, REST])).toHaveLength(1);
  });
  it('accepts a daily dose with no day types and a workout dose with one', () => {
    const ok = item('a', { doses: [dose(), dose({ slot: 'am', dayTypes: [] })] });
    expect(validateStack([ok], [LIFT, REST])).toEqual([]);
  });
  it('rejects an unknown day type', () => {
    expect(validateStack([item('a', { doses: [dose({ dayTypes: ['x'] })] })], [LIFT])).toHaveLength(1);
  });
  it('rejects a non-finite or negative ingredient amount, in an item or a part', () => {
    for (const amount of [NaN, Infinity, -1]) {
      expect(validateStack([item('a', { ingredients: [ing('caffeine', amount)] })], [LIFT])).toHaveLength(1);
      const mix = item('m', { parts: [{ itemId: 'p', name: 'p', ingredients: [ing('caffeine', amount)] }] });
      expect(validateStack([mix], [LIFT])).toHaveLength(1);
    }
    expect(validateStack([item('a', { ingredients: [ing('caffeine', 0)] })], [LIFT])).toEqual([]);
  });
  it('rejects a unit outside INGREDIENT_UNITS', () => {
    // Stored data can hold any string, which the type can't stop; JSON.parse stands in for it.
    const kg: Ingredient = JSON.parse('{"key":"caffeine","amount":100,"unit":"kg"}');
    expect(validateStack([item('a', { ingredients: [kg] })], [LIFT])).toEqual([
      expect.stringMatching(/unit "kg"/),
    ]);
  });
  it('rejects non-finite servings', () => {
    expect(validateStack([item('a', { doses: [dose({ servings: Infinity })] })], [LIFT])).toHaveLength(1);
  });
  it('rejects a session time that is not 24-hour HH:MM', () => {
    for (const sessionTime of ['9:00', '4:30 PM', '14:00:00', '24:00']) {
      expect(validateStack([], [{ ...LIFT, sessionTime }])).toHaveLength(1);
    }
    expect(validateStack([], [{ ...LIFT, sessionTime: '09:00' }, REST])).toEqual([]);
  });
});

describe('placements', () => {
  const creatine = item('creatine', {
    doses: [dose({ slot: 'pre' }), dose({ slot: 'all', dayTypes: [] })],
  });
  it('returns two on Lift day and one on Rest day', () => {
    expect(placements([creatine], 'lift')).toHaveLength(2);
    expect(placements([creatine], 'rest')).toHaveLength(1);
  });
  it('marks pending and unverified items as not counted', () => {
    const stack = [
      item('a'),
      item('b', { status: 'pending' }),
      item('c', { unverified: true }),
    ];
    expect(placements(stack, 'lift').map((p) => p.counted)).toEqual([true, false, false]);
  });
});

describe('isWorkoutSlot and hasAmount', () => {
  it('tells workout slots from daily ones', () => {
    expect(WORKOUT_SLOTS.every((s) => isWorkoutSlot(s))).toBe(true);
    expect(DAILY_SLOTS.some((s) => isWorkoutSlot(s))).toBe(false);
  });
  it('treats a blank or whitespace amount as not set', () => {
    expect(hasAmount(dose({ amount: ' ' }))).toBe(false);
    expect(hasAmount(dose({ amount: '1 scoop' }))).toBe(true);
  });
});
