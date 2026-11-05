import {
  buildMuscleTargetResolver,
  liftIdFor,
  liftSpellings,
  lookupByStoredId,
  storedIdListing,
  weeklySetsByMuscleGroup,
} from '@src/core';

// #1135: readers that match a stored `lift` string across its spellings.
describe('liftIdFor with an alternative name', () => {
  it('resolves Flat Bench Press to bench-press', () => {
    expect(liftIdFor('Flat Bench Press')).toBe('bench-press');
  });
});

describe('liftSpellings', () => {
  it('lists every stored form of a built-in lift, from any of them', () => {
    for (const name of ['Bench Press', 'bench-press', 'Bench P.', 'Flat Bench Press']) {
      expect(liftSpellings(name)).toEqual(
        expect.arrayContaining(['Bench Press', 'bench-press', 'Bench P.', 'Flat Bench Press']),
      );
    }
  });

  it('leaves a custom lift or an unknown name as itself', () => {
    expect(liftSpellings('Sissy Squat')).toEqual(['Sissy Squat']);
  });
});

describe('lookupByStoredId', () => {
  it('crosses between a name and its catalog id, both ways', () => {
    expect(lookupByStoredId([['bench-press', 1]])('Bench Press')).toBe(1);
    expect(lookupByStoredId([['Bench Press', 1]])('bench-press')).toBe(1);
  });

  it('prefers the exact name over the id', () => {
    const find = lookupByStoredId([
      ['bench-press', 'id'],
      ['Bench Press', 'name'],
    ]);
    expect(find('Bench Press')).toBe('name');
    expect(find('bench-press')).toBe('id');
  });

  it('keeps two names apart, since a program can set them up as separate slots', () => {
    const find = lookupByStoredId([['C. Lat Raise', 1]]);
    expect(liftIdFor('C. Lat Raise')).toBe(liftIdFor('Lateral Raise'));
    expect(find('Lateral Raise')).toBeUndefined();
  });

  it('finds nothing for another lift', () => {
    expect(lookupByStoredId([['bench-press', 1]])('Squat')).toBeUndefined();
  });
});

describe('storedIdListing', () => {
  it('lists an id row under a spelling of its lift, whichever arrives first', () => {
    expect(storedIdListing(['bench-press', 'Bench Press'])('bench-press')).toBe('Bench Press');
    expect(storedIdListing(['Bench Press', 'bench-press'])('Bench Press')).toBe('Bench Press');
  });

  it('leaves an id row as it is when no spelling is listed', () => {
    expect(storedIdListing(['bench-press'])('bench-press')).toBe('bench-press');
  });

  it('keeps two names apart', () => {
    const listing = storedIdListing(['C. Lat Raise', 'Lateral Raise']);
    expect(listing('C. Lat Raise')).toBe('C. Lat Raise');
    expect(listing('Lateral Raise')).toBe('Lateral Raise');
  });
});

describe('muscle volume', () => {
  it('counts Bench Press under an override stored as bench-press', () => {
    const resolve = buildMuscleTargetResolver([{ lift: 'bench-press', muscleGroups: ['Triceps'] }]);
    const [week] = weeklySetsByMuscleGroup([{ week: 1, lift: 'Bench Press', sets: 3 }], resolve);
    expect(week?.counts.map((count) => [count.key, count.sets])).toEqual([['Triceps', 3]]);
  });

  it('applies an override under Bench Press to a bench-press row', () => {
    const resolve = buildMuscleTargetResolver([{ lift: 'Bench Press', muscleGroups: ['Triceps'] }]);
    expect(resolve('bench-press')).toMatchObject({ primary: ['Triceps'], source: 'custom' });
  });
});
