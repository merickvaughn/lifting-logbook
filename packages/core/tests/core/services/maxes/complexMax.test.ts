import { complexIdOf, complexLift, complexMax } from '@src/core';

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

describe('complex row names (#1495)', () => {
  it('round-trips a complex id through a row lift, and reads an ordinary lift as none', () => {
    expect(complexLift('abc')).toBe('complex:abc');
    expect(complexIdOf(complexLift('abc'))).toBe('abc');
    expect(complexIdOf('Bench Press')).toBeUndefined();
  });
});
