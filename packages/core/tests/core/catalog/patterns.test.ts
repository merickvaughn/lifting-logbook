import {
  LIFT_CATALOG,
  MOVEMENT_PATTERN_ROWS,
  movementPatternRowsFor,
  movementPatternsFor,
} from '@src/core';

describe('movementPatternRowsFor', () => {
  it.each([
    [['push', 'horizontal'], ['Horizontal Push']],
    [['push', 'vertical'], ['Vertical Push']],
    [['pull', 'horizontal'], ['Horizontal Pull']],
    [['pull', 'vertical'], ['Vertical Pull']],
    [['squat'], ['Squat']],
    [['hinge'], ['Hinge']],
    [['carry'], ['Carry']],
  ] as const)('%p → %p', (patterns, rows) => {
    expect(movementPatternRowsFor(patterns)).toEqual(rows);
  });

  it('files a lift with no direction or lower-body pattern under "Isolation / other"', () => {
    expect(movementPatternRowsFor([])).toEqual(['Isolation / other']);
    expect(movementPatternRowsFor(['pull'])).toEqual(['Isolation / other']); // a curl
    expect(movementPatternRowsFor(['vertical'])).toEqual(['Isolation / other']);
  });

  it('gives an ambiguous direction no row rather than a guessed one', () => {
    expect(movementPatternRowsFor(['push', 'pull', 'vertical'])).toEqual(['Isolation / other']);
    expect(movementPatternRowsFor(['push', 'vertical', 'horizontal'])).toEqual(['Isolation / other']);
  });

  it('counts a multi-pattern lift toward each of its rows', () => {
    // A thruster: squat + vertical push.
    expect(movementPatternRowsFor(['squat', 'push', 'vertical'])).toEqual(['Vertical Push', 'Squat']);
  });

  it('only ever returns rows from MOVEMENT_PATTERN_ROWS', () => {
    const rows = new Set<string>(MOVEMENT_PATTERN_ROWS);
    for (const lift of LIFT_CATALOG) {
      for (const row of movementPatternRowsFor(lift.movementProfile.patterns)) {
        expect(rows.has(row)).toBe(true);
      }
    }
  });
});

describe('movementPatternsFor', () => {
  it('classifies built-ins by the torso-relative rule', () => {
    expect(movementPatternsFor('Bench Press')).toEqual(['Horizontal Push']);
    expect(movementPatternsFor('Overhead Press')).toEqual(['Vertical Push']);
    // Dip: the hands drive down along the torso.
    expect(movementPatternsFor('Dips')).toEqual(['Vertical Push']);
    // Upright Row: the bar travels up along the torso.
    expect(movementPatternsFor('Upright Row')).toEqual(['Vertical Pull']);
    // Incline pressing stays horizontal — the incline is a chest-emphasis question.
    expect(movementPatternsFor('Incline Bench Press')).toEqual(['Horizontal Push']);
    expect(movementPatternsFor('Incline DB Press')).toEqual(['Horizontal Push']);
    // Lateral Raise abducts the arm; it presses nothing.
    expect(movementPatternsFor('Lateral Raises')).toEqual(['Isolation / other']);
    expect(movementPatternsFor('Weighted Pull-ups')).toEqual(['Vertical Pull']);
    expect(movementPatternsFor('Romanian Deadlift')).toEqual(['Hinge']);
  });

  it('classifies a custom lift by its own tags, matched by exact name', () => {
    const custom = [{ name: 'Landmine Press', movementProfile: { patterns: ['push', 'vertical'] as const } }];
    expect(movementPatternsFor('Landmine Press', custom)).toEqual(['Vertical Push']);
    expect(movementPatternsFor('landmine press', custom)).toBeUndefined();
  });

  it('lets the built-in win a collision on a reserved slot name', () => {
    const custom = [{ name: 'Squat', movementProfile: { patterns: ['hinge'] as const } }];
    expect(movementPatternsFor('Squat', custom)).toEqual(['Squat']);
  });

  it.each(['Calf Raises', 'Cable Row', 'Face Pull', 'Incline Dumbbell Press'])(
    'lets a custom lift named %p keep the tags its user recorded',
    (name) => {
      // Not reserved: the custom-lift guard allows these names, so the custom lift wins.
      const custom = [{ name, movementProfile: { patterns: ['hinge'] as const } }];
      expect(movementPatternsFor(name, custom)).toEqual(['Hinge']);
    },
  );

  it('finds a custom lift by its uuid, which import can store as the lift name', () => {
    const custom = [
      { id: 'uuid-landmine', name: 'Landmine Press', movementProfile: { patterns: ['push', 'vertical'] as const } },
    ];
    expect(movementPatternsFor('uuid-landmine', custom)).toEqual(['Vertical Push']);
  });

  it('files both curls under "Isolation / other" — a lone pull tag earns no direction', () => {
    expect(movementPatternsFor('Cable Curl')).toEqual(['Isolation / other']);
    expect(movementPatternsFor('Leg Curl')).toEqual(['Isolation / other']);
  });

  it('returns undefined for a lift it has never heard of', () => {
    expect(movementPatternsFor('Zercher Good Morning')).toBeUndefined();
  });
});
