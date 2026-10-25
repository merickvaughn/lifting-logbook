import { FOCUS_AREAS, FOCUS_AREA_MUSCLES, MUSCLE_GROUPS, type FocusSelection } from '@lifting-logbook/types';
import { buildMuscleTargetResolver, selectForDay } from '@src/core';
import { block, entry, resolveMuscles } from './focusFixtures';

const lifts = (items: { lift: string }[]) => items.map((item) => item.lift);

describe('focus areas', () => {
  it('maps every area onto MUSCLE_GROUPS', () => {
    const vocabulary = new Set<string>(MUSCLE_GROUPS);
    for (const area of FOCUS_AREAS) {
      expect(FOCUS_AREA_MUSCLES[area].length).toBeGreaterThan(0);
      for (const muscle of FOCUS_AREA_MUSCLES[area]) expect(vocabulary.has(muscle)).toBe(true);
    }
    expect(FOCUS_AREA_MUSCLES.Shoulders).toEqual(['Front Delts', 'Side Delts', 'Rear Delts']);
    expect(FOCUS_AREA_MUSCLES.Back).toEqual(['Lats', 'Upper Back', 'Traps', 'Lower Back']);
  });
});

describe('selectForDay', () => {
  it('Rules selects every eligible lift, never off or swap-only lifts', () => {
    const b = block({
      pool: [entry('A'), entry('B', { include: 'off' }), entry('C', { include: 'swap' }), entry('D', { include: 'always' })],
    });
    const result = selectForDay(b, ['Fixture Squat'], 0, undefined, resolveMuscles);
    expect(lifts(result.items)).toEqual(['A', 'D']);
    expect(result).toMatchObject({ skipped: [], suggestions: [], overlap: null, mode: 'rules' });
  });

  it('applies a rule lift only when its rule lift is planned', () => {
    const b = block({ pool: [entry('A', { include: 'rule', ruleLift: 'Fixture Squat' }), entry('B')] });
    const planned = selectForDay(b, ['Fixture Squat'], 0, undefined, resolveMuscles);
    expect(lifts(planned.items)).toEqual(['B']);
    expect(planned.skipped).toEqual([{ lift: 'A', reason: 'rule', detail: 'Fixture Squat' }]);
    expect(lifts(selectForDay(b, ['Fixture Chin-up'], 0, undefined, resolveMuscles).items)).toEqual(['A', 'B']);
  });

  it('treats a rule lift with no rule lift set as eligible', () => {
    const b = block({ pool: [entry('A', { include: 'rule' })] });
    expect(lifts(selectForDay(b, [], 0, undefined, resolveMuscles).items)).toEqual(['A']);
  });

  it('Rotate cycles one flex lift by rotation index, with Always lifts on top', () => {
    const b = block({ selection: 'rotate', pool: [entry('A'), entry('B'), entry('C', { include: 'always' })] });
    const on = (index: number) => selectForDay(b, [], index, undefined, resolveMuscles);
    expect(lifts(on(0).items)).toEqual(['C', 'A']);
    expect(lifts(on(1).items)).toEqual(['C', 'B']);
    expect(lifts(on(2).items)).toEqual(['C', 'A']);
    expect(lifts(on(-1).items)).toEqual(['C', 'B']);
    expect(on(1).skipped).toEqual([{ lift: 'A', reason: 'rotation', detail: '' }]);
  });

  it('Rotate reaches every lift of a pool larger than a week when the index keeps counting', () => {
    const b = block({ selection: 'rotate', pool: [entry('A'), entry('B'), entry('C'), entry('D')] });
    // Three workouts a week: workouts 0–5 of the block.
    const picked = [0, 1, 2, 3, 4, 5].map((index) => lifts(selectForDay(b, [], index, undefined, resolveMuscles).items));
    expect(picked).toEqual([['A'], ['B'], ['C'], ['D'], ['A'], ['B']]);
  });

  it('Rotate with only Always lifts selects just those', () => {
    const b = block({ selection: 'rotate', pool: [entry('C', { include: 'always' })] });
    const result = selectForDay(b, [], 1, undefined, resolveMuscles);
    expect(lifts(result.items)).toEqual(['C']);
    expect(result.skipped).toEqual([]);
  });

  it('Fixed uses the first flex lift every workout', () => {
    const b = block({ selection: 'fixed', pool: [entry('A'), entry('B'), entry('C', { include: 'always' })] });
    const result = selectForDay(b, [], 2, undefined, resolveMuscles);
    expect(lifts(result.items)).toEqual(['C', 'A']);
    expect(result.skipped).toEqual([{ lift: 'B', reason: 'fixed', detail: 'A' }]);
    const alwaysOnly = block({ selection: 'fixed', pool: [entry('C', { include: 'always' })] });
    expect(lifts(selectForDay(alwaysOnly, [], 0, undefined, resolveMuscles).items)).toEqual(['C']);
  });

  it('I pick offers the flex lifts and selects the picks plus Always lifts', () => {
    const b = block({ selection: 'pick', pool: [entry('A'), entry('B'), entry('C', { include: 'always' })] });
    const unpicked = selectForDay(b, [], 0, undefined, resolveMuscles);
    expect(lifts(unpicked.items)).toEqual(['C']);
    expect(lifts(unpicked.suggestions)).toEqual(['A', 'B']);
    const picked = selectForDay(b, [], 0, { modes: {}, picks: { sh: ['B'] } }, resolveMuscles);
    expect(lifts(picked.items)).toEqual(['B', 'C']);
  });

  it('a day mode override replaces the block selection', () => {
    const b = block({ selection: 'rules', pool: [entry('A'), entry('B')] });
    const result = selectForDay(b, [], 0, { modes: { sh: 'fixed' }, picks: {} }, resolveMuscles);
    expect(result.mode).toBe('fixed');
    expect(lifts(result.items)).toEqual(['A']);
  });

  it('ignores day-state keys inherited from Object.prototype', () => {
    const b = block({ id: 'constructor', selection: 'pick', pool: [entry('A')] });
    const result = selectForDay(b, [], 0, { modes: {}, picks: {} }, resolveMuscles);
    expect(result.mode).toBe('pick');
    expect(result.items).toEqual([]);
  });

  it('throws on a selection mode it does not know', () => {
    const b = block({ selection: 'bogus' as FocusSelection });
    expect(() => selectForDay(b, [], 0, undefined, resolveMuscles)).toThrow('Unknown focus selection mode: bogus');
  });

  it('detects overlap from primary muscles only', () => {
    const triceps = block({ area: 'Triceps', overlap: 'skip', pool: [entry('Pushdown')] });
    expect(selectForDay(triceps, ['Fixture Bench'], 0, undefined, resolveMuscles).overlap).toBeNull();
    expect(selectForDay(triceps, ['Fixture Bench', 'Fixture Dips'], 0, undefined, resolveMuscles).overlap).toEqual({
      lifts: ['Fixture Dips'],
      mode: 'skip',
    });
  });

  it('detects overlap through a user override', () => {
    const calves = block({ area: 'Calves', overlap: 'skip', pool: [entry('Calf Raise')] });
    const overridden = buildMuscleTargetResolver([{ lift: 'Fixture Squat', muscleGroups: ['Quads', 'Calves'] }]);
    expect(selectForDay(calves, ['Fixture Squat'], 0, undefined, resolveMuscles).items).toHaveLength(1);
    expect(selectForDay(calves, ['Fixture Squat'], 0, undefined, overridden).items).toEqual([]);
  });

  it('Skip drops every lift and names each overlapping planned lift once', () => {
    const b = block({ overlap: 'skip', pool: [entry('A'), entry('B')] });
    const planned = ['Fixture Overhead Press', 'Fixture Squat', 'Fixture Arnold Press', 'Fixture Overhead Press'];
    const result = selectForDay(b, planned, 0, undefined, resolveMuscles);
    const who = 'Fixture Overhead Press & Fixture Arnold Press';
    expect(result.items).toEqual([]);
    expect(result.overlap).toEqual({ lifts: ['Fixture Overhead Press', 'Fixture Arnold Press'], mode: 'skip' });
    expect(result.skipped).toEqual([
      { lift: 'A', reason: 'overlap', detail: who },
      { lift: 'B', reason: 'overlap', detail: who },
    ]);
  });

  it('Reduce takes one set off each lift, never below one', () => {
    const b = block({ overlap: 'reduce', pool: [entry('A', { sets: 3 }), entry('B', { sets: 1 })] });
    const result = selectForDay(b, ['Fixture Overhead Press'], 0, undefined, resolveMuscles);
    expect(result.items.map(({ lift, sets, reducedFrom }) => ({ lift, sets, reducedFrom }))).toEqual([
      { lift: 'A', sets: 2, reducedFrom: 3 },
      { lift: 'B', sets: 1, reducedFrom: undefined },
    ]);
  });

  it('Swap replaces lifts with their swap targets and de-duplicates', () => {
    const b = block({
      overlap: 'swap',
      pool: [
        entry('A', { swapTo: 'Face Pull' }),
        entry('B', { swapTo: 'Face Pull' }),
        entry('C'),
        entry('D', { swapTo: 'Missing' }),
        entry('Face Pull', { include: 'swap', sets: 4 }),
      ],
    });
    const result = selectForDay(b, ['Fixture Overhead Press'], 0, undefined, resolveMuscles);
    expect(result.items.map(({ lift, sets, swappedFrom }) => ({ lift, sets, swappedFrom }))).toEqual([
      { lift: 'Face Pull', sets: 4, swappedFrom: 'A' },
      { lift: 'C', sets: 3, swappedFrom: undefined },
      { lift: 'D', sets: 3, swappedFrom: undefined },
    ]);
  });

  it('Swap keeps the original when the target is off or excluded by its own rule', () => {
    const b = block({
      overlap: 'swap',
      pool: [
        entry('A', { swapTo: 'Upright Row' }),
        entry('B', { swapTo: 'Retired' }),
        entry('Upright Row', { include: 'rule', ruleLift: 'Fixture Overhead Press' }),
        entry('Retired', { include: 'off' }),
      ],
    });
    const result = selectForDay(b, ['Fixture Overhead Press'], 0, undefined, resolveMuscles);
    expect(lifts(result.items)).toEqual(['A', 'B']);
    expect(result.items.every((item) => item.swappedFrom === undefined)).toBe(true);
  });

  it('Do it anyway keeps the full prescription but reports the overlap', () => {
    const b = block({ overlap: 'anyway', pool: [entry('A')] });
    const result = selectForDay(b, ['Fixture Overhead Press'], 0, undefined, resolveMuscles);
    expect(result.items).toEqual([{ entry: entry('A'), lift: 'A', sets: 3 }]);
    expect(result.overlap).toEqual({ lifts: ['Fixture Overhead Press'], mode: 'anyway' });
  });
});
