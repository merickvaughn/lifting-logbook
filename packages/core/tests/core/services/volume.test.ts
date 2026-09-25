import {
  PRESET_BASE_SPECS,
  buildMuscleTargetResolver,
  collapseIdenticalWeeks,
  formatSetCount,
  movementPatternsFor,
  weeklySetCounts,
  weeklySetsByMuscleGroup,
  weeklySetsByPattern,
  type VolumeSlot,
  type WeeklyVolume,
} from '@src/core';

// A missing preset yields no slots, which every assertion below then fails on loudly.
const slotsOf = (program: string): VolumeSlot[] =>
  (PRESET_BASE_SPECS[program] ?? []).map((row) => ({ week: row.week, lift: row.lift, sets: row.sets }));

const asRecord = (week: WeeklyVolume | undefined) =>
  week && Object.fromEntries(week.counts.map((count) => [count.key, count.sets]));

describe('weeklySetCounts', () => {
  const credits = (lift: string) =>
    lift === 'A' ? [{ key: 'x', weight: 1 }] : lift === 'B' ? [{ key: 'X', weight: 0.5 }] : undefined;

  it('groups slots by week, ascending, and sums sets × weight per row', () => {
    const weeks = weeklySetCounts(
      [
        { week: 2, lift: 'A', sets: 3 },
        { week: 1, lift: 'A', sets: 2 },
        { week: 1, lift: 'B', sets: 4 },
      ],
      credits,
    );
    expect(weeks.map((w) => w.week)).toEqual([1, 2]);
    // "x" and "X" merge case-insensitively under the first spelling seen.
    expect(weeks[0]?.counts).toEqual([{ key: 'x', sets: 4 }]);
    expect(weeks[1]?.counts).toEqual([{ key: 'x', sets: 3 }]);
  });

  it('reports a lift with no credits as uncounted instead of dropping it', () => {
    const [week] = weeklySetCounts(
      [
        { week: 1, lift: 'Mystery', sets: 3 },
        { week: 1, lift: 'Mystery', sets: 2 },
      ],
      credits,
    );
    expect(week?.counts).toEqual([]);
    expect(week?.uncounted).toEqual([{ lift: 'Mystery', sets: 5 }]);
  });

  it.each([0, -1, NaN, Infinity])('ignores a slot whose sets is %p', (sets) => {
    expect(weeklySetCounts([{ week: 1, lift: 'A', sets }], credits)).toEqual([]);
  });
});

describe('weeklySetsByMuscleGroup', () => {
  it('credits primaries 1 and secondaries ½ per working set', () => {
    const [week] = weeklySetsByMuscleGroup(
      [{ week: 1, lift: 'Bench Press', sets: 3 }],
      buildMuscleTargetResolver([]),
    );
    expect(week?.counts).toEqual([
      { key: 'Chest', sets: 3 },
      { key: 'Front Delts', sets: 1.5 },
      { key: 'Triceps', sets: 1.5 },
    ]);
  });

  it('sorts by sets, then vocabulary order, then free text alphabetically', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Custom', muscleGroups: ['zygomatic', 'Calves', 'Chest', 'abductors'] },
    ]);
    const [week] = weeklySetsByMuscleGroup([{ week: 1, lift: 'Custom', sets: 2 }], resolve);
    expect(week?.counts.map((c) => c.key)).toEqual(['Chest', 'Calves', 'abductors', 'zygomatic']);
  });

  it('reproduces the proposal worked example for Leangains with default muscles', () => {
    const weeks = weeklySetsByMuscleGroup(slotsOf('leangains'), buildMuscleTargetResolver([]));
    expect(weeks).toHaveLength(1);
    expect(asRecord(weeks[0])).toEqual({
      Chest: 9,
      'Front Delts': 7.5,
      Triceps: 7.5,
      Hamstrings: 7,
      Glutes: 7,
      Lats: 6,
      'Side Delts': 5.5,
      'Upper Back': 5,
      Calves: 4,
      'Lower Back': 4,
      Quads: 3.5,
      Biceps: 3,
      Adductors: 1.5,
      'Rear Delts': 1.5,
      Forearms: 0.5,
      Traps: 0.5,
    });
    expect(weeks[0]?.uncounted).toEqual([]);
  });

  it('counts every lift of every built-in preset — nothing falls through as uncounted', () => {
    for (const program of Object.keys(PRESET_BASE_SPECS)) {
      for (const week of weeklySetsByMuscleGroup(slotsOf(program), buildMuscleTargetResolver([]))) {
        expect({ program, uncounted: week.uncounted }).toEqual({ program, uncounted: [] });
      }
    }
  });

  it('applies a user override in place of the defaults', () => {
    const [week] = weeklySetsByMuscleGroup(
      [{ week: 1, lift: 'Bench Press', sets: 3 }],
      buildMuscleTargetResolver([{ lift: 'Bench Press', muscleGroups: ['Chest', 'Triceps'] }]),
    );
    expect(asRecord(week)).toEqual({ Chest: 3, Triceps: 3 });
  });

  it('lists an untagged custom lift as uncounted', () => {
    const [week] = weeklySetsByMuscleGroup(
      [{ week: 1, lift: 'Sissy Squat', sets: 3 }],
      buildMuscleTargetResolver([]),
    );
    expect(week?.counts).toEqual([]);
    expect(week?.uncounted).toEqual([{ lift: 'Sissy Squat', sets: 3 }]);
  });
});

describe('weeklySetsByPattern', () => {
  it('reproduces the proposal worked example for Leangains', () => {
    const weeks = weeklySetsByPattern(slotsOf('leangains'), (lift) => movementPatternsFor(lift));
    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.counts).toEqual([
      { key: 'Horizontal Push', sets: 6 },
      { key: 'Vertical Push', sets: 6 },
      { key: 'Horizontal Pull', sets: 3 },
      { key: 'Vertical Pull', sets: 3 },
      { key: 'Squat', sets: 3 },
      { key: 'Hinge', sets: 4 },
      { key: 'Isolation / other', sets: 11 },
    ]);
    expect(weeks[0]?.uncounted).toEqual([]);
  });

  it('lists a lift with no known pattern as uncounted', () => {
    const [week] = weeklySetsByPattern([{ week: 1, lift: 'Mystery', sets: 2 }], (lift) =>
      movementPatternsFor(lift),
    );
    expect(week?.uncounted).toEqual([{ lift: 'Mystery', sets: 2 }]);
  });
});

describe('collapseIdenticalWeeks', () => {
  it("merges 5-3-1's three identical weeks into one column", () => {
    const columns = collapseIdenticalWeeks(
      weeklySetsByMuscleGroup(slotsOf('5-3-1'), buildMuscleTargetResolver([])),
    );
    expect(columns).toHaveLength(1);
    expect(columns[0]?.weeks).toEqual([1, 2, 3]);
  });

  it('keeps weeks that differ as separate columns, in first-appearance order', () => {
    const resolve = buildMuscleTargetResolver([]);
    const columns = collapseIdenticalWeeks(
      weeklySetsByMuscleGroup(
        [
          { week: 1, lift: 'Bench Press', sets: 3 },
          { week: 2, lift: 'Bench Press', sets: 5 },
          { week: 3, lift: 'Bench Press', sets: 3 },
        ],
        resolve,
      ),
    );
    expect(columns.map((c) => c.weeks)).toEqual([[1, 3], [2]]);
  });
});

describe('formatSetCount', () => {
  it.each([
    [3, '3'],
    [1.5, '1.5'],
    [0.5, '0.5'],
    [7.499999999, '7.5'],
    [0, '0'],
  ])('%p → %p', (sets, text) => {
    expect(formatSetCount(sets)).toBe(text);
  });
});
