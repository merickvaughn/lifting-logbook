import { MAX_SET_NUM, MAX_SET_OCCURRENCE, complexIdOf, complexLift, complexMax, complexSetKey } from '@src/core';

const maxes = (byLift: Record<string, number>) => (lift: string) => byLift[lift];

describe('complexMax — weakest-link loading (#1495)', () => {
  const components = [{ lift: 'Power Clean' }, { lift: 'Front Squat' }, { lift: 'Push Press' }];

  it('plans from the lowest component max and names that lift as limiting', () => {
    expect(complexMax(components, maxes({ 'Power Clean': 135, 'Front Squat': 185, 'Push Press': 155 }))).toEqual({
      weight: 135,
      limitingLift: 'Power Clean',
    });
    expect(complexMax(components, maxes({ 'Power Clean': 200, 'Front Squat': 185, 'Push Press': 155 }))).toEqual({
      weight: 155,
      limitingLift: 'Push Press',
    });
  });

  it('names the first component on a tie', () => {
    expect(complexMax(components, maxes({ 'Power Clean': 155, 'Front Squat': 185, 'Push Press': 155 }))).toEqual({
      weight: 155,
      limitingLift: 'Power Clean',
    });
  });

  it('leaves the complex unplanned when a component has no max, listing each such lift once', () => {
    const repeated = [...components, { lift: 'Front Squat' }];
    expect(complexMax(repeated, maxes({ 'Power Clean': 135, 'Front Squat': 0 }))).toEqual({
      missing: ['Front Squat', 'Push Press'],
    });
  });
});

describe('complexSetKey — where a logged complex set is stored (#1496)', () => {
  it('numbers each round’s components in order, from an occurrence at the top of the range', () => {
    expect(complexSetKey(0, 1, 0, 3)).toEqual({ occurrence: MAX_SET_OCCURRENCE, setNum: 1 });
    expect(complexSetKey(0, 1, 2, 3)).toEqual({ occurrence: MAX_SET_OCCURRENCE, setNum: 3 });
    expect(complexSetKey(0, 2, 0, 3)).toEqual({ occurrence: MAX_SET_OCCURRENCE, setNum: 4 });
  });

  it('gives a second complex slot in the day an occurrence of its own', () => {
    expect(complexSetKey(1, 1, 0, 3)?.occurrence).toBe(MAX_SET_OCCURRENCE - 1);
  });

  it('has no key once a round would pass the highest set number', () => {
    expect(complexSetKey(0, 25, 1, 2)).toEqual({ occurrence: MAX_SET_OCCURRENCE, setNum: MAX_SET_NUM });
    expect(complexSetKey(0, 26, 0, 2)).toBeUndefined();
    expect(complexSetKey(MAX_SET_OCCURRENCE, 1, 0, 2)).toBeUndefined();
  });
});

describe('complex row names (#1495)', () => {
  it('round-trips a complex id through a row lift, and reads an ordinary lift as none', () => {
    expect(complexLift('abc')).toBe('complex:abc');
    expect(complexIdOf(complexLift('abc'))).toBe('abc');
    expect(complexIdOf('Bench Press')).toBeUndefined();
  });
});
