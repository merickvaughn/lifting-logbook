import { MUSCLE_GROUPS } from '@lifting-logbook/types';
import {
  LIFT_CATALOG,
  buildMuscleTargetResolver,
  canonicalMuscleGroup,
  defaultMuscleTargetsFor,
} from '@src/core';

describe('catalog default muscles', () => {
  const vocabulary = new Set<string>(MUSCLE_GROUPS);

  it('gives every catalog lift at least one primary muscle', () => {
    expect(LIFT_CATALOG.length).toBeGreaterThan(0);
    for (const lift of LIFT_CATALOG) {
      expect({ id: lift.id, primaries: lift.muscles.primary.length > 0 }).toEqual({
        id: lift.id,
        primaries: true,
      });
    }
  });

  it('uses only vocabulary muscle groups, with no duplicates and no primary/secondary overlap', () => {
    for (const lift of LIFT_CATALOG) {
      const all = [...lift.muscles.primary, ...lift.muscles.secondary];
      for (const group of all) expect(vocabulary.has(group)).toBe(true);
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('reads defaults through every name a lift goes by', () => {
    const backSquat = LIFT_CATALOG.find((lift) => lift.id === 'back-squat')?.muscles;
    // Without this, a missing entry would make every toBe below compare undefined to undefined.
    expect(backSquat).toBeDefined();
    expect(defaultMuscleTargetsFor('Back Squat')).toBe(backSquat); // display name
    expect(defaultMuscleTargetsFor('back-squat')).toBe(backSquat); // id
    expect(defaultMuscleTargetsFor('Squat')).toBe(backSquat); // slot name
    expect(defaultMuscleTargetsFor('Calf Raises')?.primary).toEqual(['Calves']); // alias
    expect(defaultMuscleTargetsFor('Sissy Squat')).toBeUndefined();
  });
});

describe('canonicalMuscleGroup', () => {
  it('maps any casing and padding of a vocabulary name to its canonical spelling', () => {
    expect(canonicalMuscleGroup('quads')).toBe('Quads');
    expect(canonicalMuscleGroup('  upper back ')).toBe('Upper Back');
    expect(canonicalMuscleGroup('FRONT DELTS')).toBe('Front Delts');
  });

  it('keeps free text outside the vocabulary, trimmed', () => {
    expect(canonicalMuscleGroup(' Quadriceps ')).toBe('Quadriceps');
    expect(canonicalMuscleGroup('serratus')).toBe('serratus');
  });
});

describe('buildMuscleTargetResolver', () => {
  it('uses the built-in defaults when the user has no override', () => {
    const resolve = buildMuscleTargetResolver([]);
    expect(resolve('Bench Press')).toEqual({
      primary: ['Chest'],
      secondary: ['Triceps', 'Front Delts'],
      source: 'default',
    });
  });

  it('lets a non-empty override on the exact lift name replace both lists', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Bench Press', muscleGroups: ['Chest', 'Triceps'], secondaryMuscleGroups: [] },
    ]);
    expect(resolve('Bench Press')).toEqual({
      primary: ['Chest', 'Triceps'],
      secondary: [],
      source: 'custom',
    });
  });

  it('reads an override with only secondary muscles as custom', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Bench Press', muscleGroups: [], secondaryMuscleGroups: ['Triceps'] },
    ]);
    expect(resolve('Bench Press')).toEqual({ primary: [], secondary: ['Triceps'], source: 'custom' });
  });

  it('treats an override with both lists empty as "use the defaults"', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Bench Press', muscleGroups: [], secondaryMuscleGroups: [] },
    ]);
    expect(resolve('Bench Press').source).toBe('default');
  });

  it('reads a row written before secondary muscles existed', () => {
    const resolve = buildMuscleTargetResolver([{ lift: 'Squat', muscleGroups: ['quads'] }]);
    expect(resolve('Squat')).toEqual({ primary: ['Quads'], secondary: [], source: 'custom' });
  });

  it('does not follow aliases — an override on "Squat" leaves "Back Squat" on its defaults', () => {
    const resolve = buildMuscleTargetResolver([{ lift: 'Squat', muscleGroups: ['Quads'] }]);
    expect(resolve('Squat').source).toBe('custom');
    expect(resolve('Back Squat').source).toBe('default');
  });

  it('gives a custom lift with no override nothing to count', () => {
    const resolve = buildMuscleTargetResolver([]);
    expect(resolve('Sissy Squat')).toEqual({ primary: [], secondary: [], source: 'none' });
  });

  it('counts a custom lift once the user tags it', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Sissy Squat', muscleGroups: ['Quads'], secondaryMuscleGroups: [] },
    ]);
    expect(resolve('Sissy Squat')).toEqual({ primary: ['Quads'], secondary: [], source: 'custom' });
  });

  it('canonicalizes and dedupes legacy free-text tags before counting them', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Squat', muscleGroups: ['Quads', 'quads', ' QUADS ', '', 'Quadriceps'] },
    ]);
    expect(resolve('Squat').primary).toEqual(['Quads', 'Quadriceps']);
  });

  it('counts a muscle listed as both primary and secondary as primary only', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Dips', muscleGroups: ['Chest'], secondaryMuscleGroups: ['chest', 'Triceps'] },
    ]);
    expect(resolve('Dips')).toEqual({ primary: ['Chest'], secondary: ['Triceps'], source: 'custom' });
  });

  describe('legacy URL-encoded lift names (issue #1017)', () => {
    it('applies a row stored as "Bench%20Press" to "Bench Press"', () => {
      const resolve = buildMuscleTargetResolver([
        { lift: 'Bench%20Press', muscleGroups: ['Chest'], secondaryMuscleGroups: [] },
      ]);
      expect(resolve('Bench Press')).toEqual({ primary: ['Chest'], secondary: [], source: 'custom' });
    });

    it.each([
      ['encoded row first', ['Bench%20Press', 'Bench Press']],
      ['real row first', ['Bench Press', 'Bench%20Press']],
    ])('prefers the row stored under the real name (%s)', (_label, order) => {
      const rows = {
        'Bench Press': { lift: 'Bench Press', muscleGroups: ['Triceps'] },
        'Bench%20Press': { lift: 'Bench%20Press', muscleGroups: ['Front Delts'] },
      } as const;
      const resolve = buildMuscleTargetResolver(order.map((key) => rows[key as keyof typeof rows]));
      expect(resolve('Bench Press').primary).toEqual(['Triceps']);
    });

    it('keeps a name that is not valid percent-encoding under its stored name', () => {
      // No whitespace, so it looks encoded — but "%Ef" is a lone UTF-8 lead byte and
      // decodeURIComponent throws. The row must stay reachable, not vanish or crash the build.
      const resolve = buildMuscleTargetResolver([{ lift: '100%Effort', muscleGroups: ['Quads'] }]);
      expect(resolve('100%Effort')).toEqual({ primary: ['Quads'], secondary: [], source: 'custom' });
    });

    it('finds a real name containing a valid escape by its own name', () => {
      // A name with whitespace was never encoded, so "Bench %75" is taken at its word.
      const resolve = buildMuscleTargetResolver([{ lift: 'Bench %75', muscleGroups: ['Chest'] }]);
      expect(resolve('Bench %75').source).toBe('custom');
      expect(resolve('Bench u').source).toBe('none');
    });

    it('never re-keys a real name onto a different lift', () => {
      const resolve = buildMuscleTargetResolver([{ lift: 'Squat %40 RPE', muscleGroups: ['Quads'] }]);
      expect(resolve('Squat %40 RPE').source).toBe('custom');
      expect(resolve('Squat @ RPE').source).toBe('none');
    });

    it('lets an explicit both-empty row under the real name restore the defaults', () => {
      // What the lift editor's reset will write (#1017): the real-name row wins over its
      // legacy encoded twin, and empty lists mean "use the defaults".
      const resolve = buildMuscleTargetResolver([
        { lift: 'Bench%20Press', muscleGroups: ['Triceps'] },
        { lift: 'Bench Press', muscleGroups: [], secondaryMuscleGroups: [] },
      ]);
      expect(resolve('Bench Press').source).toBe('default');
    });
  });

  it('keys an override on an alias name to that alias only', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Calf Raises', muscleGroups: ['Calves', 'Hamstrings'] },
    ]);
    expect(resolve('Calf Raises').source).toBe('custom');
    expect(resolve('Calf Raise').source).toBe('default');
  });

  it("gives a custom lift that shares a built-in's name that built-in's defaults", () => {
    // Defaults attach to the name: a custom "Cable Row" carries no muscle data of its own.
    const resolve = buildMuscleTargetResolver([], [{ id: 'uuid-cable-row', name: 'Cable Row' }]);
    expect(resolve('Cable Row').source).toBe('default');
  });

  it("reads a custom lift's overrides when a record names it by uuid", () => {
    // Import can store a mid-import custom lift's uuid in the record's `lift` column.
    const resolve = buildMuscleTargetResolver(
      [{ lift: 'Sissy Squat', muscleGroups: ['Quads'] }],
      [{ id: 'uuid-sissy', name: 'Sissy Squat' }],
    );
    expect(resolve('uuid-sissy')).toEqual({ primary: ['Quads'], secondary: [], source: 'custom' });
  });
});
