import {
  PRESET_BASE_SPECS,
  buildMuscleTargetResolver,
  collapseIdenticalWeeks,
  formatSetCount,
  movementPatternsFor,
  toVolumeTable,
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

  it.each([0, -1, NaN, Infinity])('counts nothing for a slot whose sets is %p, but keeps its week', (sets) => {
    // A program editor mid-keystroke zeroes a week; it must read as an empty week, not vanish.
    expect(weeklySetCounts([{ week: 1, lift: 'A', sets }], credits)).toEqual([
      { week: 1, counts: [], uncounted: [] },
    ]);
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

  it('sorts by sets, then vocabulary order, then free text in code-unit order', () => {
    const resolve = buildMuscleTargetResolver([
      { lift: 'Custom', muscleGroups: ['zygomatic', 'Calves', 'Chest', 'abductors'] },
    ]);
    const [week] = weeklySetsByMuscleGroup([{ week: 1, lift: 'Custom', sets: 2 }], resolve);
    expect(week?.counts.map((c) => c.key)).toEqual(['Chest', 'Calves', 'abductors', 'zygomatic']);
  });

  it('orders free-text ties by code unit, never by the runtime locale', () => {
    // Czech collation puts "hips" before "chin" ("ch" sorts after "h"); a server render and
    // the browser's re-render must agree whatever their locales.
    const resolve = buildMuscleTargetResolver([{ lift: 'Custom', muscleGroups: ['hips', 'chin'] }]);
    const [week] = weeklySetsByMuscleGroup([{ week: 1, lift: 'Custom', sets: 1 }], resolve);
    expect(week?.counts.map((c) => c.key)).toEqual(['chin', 'hips']);
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
    const programs = Object.keys(PRESET_BASE_SPECS);
    // Both loops below would pass vacuously over an empty extraction.
    expect(programs.length).toBeGreaterThan(0);
    for (const program of programs) {
      const weeks = weeklySetsByMuscleGroup(slotsOf(program), buildMuscleTargetResolver([]));
      expect({ program, weeks: weeks.length > 0 }).toEqual({ program, weeks: true });
      for (const week of weeks) {
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

  it('keeps a week whose sets were all zeroed as its own column', () => {
    // Without the empty week, weeks 1 and 3 would collapse to one column that claims
    // every week is identical.
    const columns = collapseIdenticalWeeks(
      weeklySetsByMuscleGroup(
        [
          { week: 1, lift: 'Bench Press', sets: 3 },
          { week: 2, lift: 'Bench Press', sets: 0 },
          { week: 3, lift: 'Bench Press', sets: 3 },
        ],
        buildMuscleTargetResolver([]),
      ),
    );
    expect(columns.map((c) => c.weeks)).toEqual([[1, 3], [2]]);
    expect(columns[1]?.volume.counts).toEqual([]);
  });
});

describe('toVolumeTable', () => {
  const week = (n: number, counts: [string, number][], uncounted: [string, number][] = []): WeeklyVolume => ({
    week: n,
    counts: counts.map(([key, sets]) => ({ key, sets })),
    uncounted: uncounted.map(([lift, sets]) => ({ lift, sets })),
  });

  it('aligns columns on one row order, reading 0 where a column lacks a row', () => {
    const table = toVolumeTable(
      [week(1, [['Chest', 3], ['Triceps', 1.5]]), week(2, [['Triceps', 4], ['Lats', 3]])],
      'muscle',
    );
    // Ordered by total across columns: Triceps 5.5, Chest 3, Lats 3 (vocabulary breaks the tie).
    expect(table.rows).toEqual([
      { key: 'Triceps', sets: [1.5, 4] },
      { key: 'Chest', sets: [3, 0] },
      { key: 'Lats', sets: [0, 3] },
    ]);
  });

  it('joins keys case-insensitively under the first spelling seen', () => {
    const table = toVolumeTable([week(1, [['quadriceps', 2]]), week(2, [['Quadriceps', 1]])], 'muscle');
    expect(table.rows).toEqual([{ key: 'quadriceps', sets: [2, 1] }]);
  });

  it('keeps pattern rows in their fixed order regardless of totals', () => {
    const table = toVolumeTable(
      [week(1, [['Hinge', 9], ['Vertical Push', 1], ['Horizontal Push', 2]])],
      'pattern',
    );
    expect(table.rows.map((row) => row.key)).toEqual(['Horizontal Push', 'Vertical Push', 'Hinge']);
  });

  it('aligns uncounted lifts across columns, heaviest first', () => {
    const table = toVolumeTable(
      [week(1, [], [['Mystery', 2]]), week(2, [], [['Other', 5], ['Mystery', 1]])],
      'muscle',
    );
    expect(table.uncounted).toEqual([
      { lift: 'Other', sets: [0, 5] },
      { lift: 'Mystery', sets: [2, 1] },
    ]);
  });

  it('returns empty rows for no columns', () => {
    expect(toVolumeTable([], 'muscle')).toEqual({ rows: [], uncounted: [] });
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
