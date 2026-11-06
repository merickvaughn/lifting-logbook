import { validateStrengthGoalImport, type StrengthGoalEntry } from '@src/core';

const goal = (lift: string, target: number): StrengthGoalEntry => ({
  lift,
  goalType: 'absolute',
  unit: 'lbs',
  target,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

const collisions = (rows: StrengthGoalEntry[]) => validateStrengthGoalImport(rows).goalSpellingCollisions;

// #1169: two rows in one file that resolve to one lift can't both apply as its goal.
describe('strength-goal spelling collisions', () => {
  it('names both spellings of Squat and Back Squat, in file order, with where each stores', () => {
    expect(collisions([goal('Squat', 350), goal('Back Squat', 400)])).toEqual([
      {
        key: 'back-squat',
        rows: [
          { spelling: 'Squat', lift: 'back-squat', value: '350 lbs', rowIndexes: [1] },
          { spelling: 'Back Squat', lift: 'Back Squat', value: '400 lbs', rowIndexes: [2] },
        ],
      },
    ]);
  });

  it('flags OH Press and OH Press-HV, which share one stored lift, listing the stored row first', () => {
    const rows = [goal('OH Press-HV', 100), goal('OH Press', 150)];
    expect(validateStrengthGoalImport(rows).valid.map((g) => g.lift)).toEqual(['overhead-press', 'overhead-press']);
    const [collision] = collisions(rows);
    expect(collision?.key).toBe('overhead-press');
    expect(collision?.rows.map((r) => [r.spelling, r.value])).toEqual([
      ['OH Press-HV', '100 lbs'],
      ['OH Press', '150 lbs'],
    ]);
  });

  it('shows a relative goal as a preview does', () => {
    const relative = { ...goal('Squat', 0), goalType: 'relative', ratio: 1.5 } as StrengthGoalEntry;
    expect(collisions([relative, goal('Back Squat', 400)])[0]?.rows[0]?.value).toBe('1.5× bodyweight');
  });

  it('gathers every row of a spelling, showing the first, so keeping it moves them all', () => {
    expect(collisions([goal('Squat', 350), goal('Back Squat', 400), goal('Squat', 360)])[0]?.rows[0]).toEqual({
      spelling: 'Squat',
      lift: 'back-squat',
      value: '350 lbs',
      rowIndexes: [1, 3],
    });
  });

  it('counts positions among all the rows, including ones that failed validation', () => {
    const invalid = { ...goal('Deadlift', 500), unit: 'stone' } as unknown as StrengthGoalEntry;
    expect(collisions([invalid, goal('Squat', 350), goal('Back Squat', 400)])[0]?.rows.map((r) => r.rowIndexes)).toEqual(
      [[2], [3]],
    );
  });

  it('finds nothing for one spelling of each lift', () => {
    expect(collisions([goal('Squat', 350), goal('Bench P.', 250)])).toEqual([]);
  });

  it('finds nothing for one spelling written twice', () => {
    expect(collisions([goal('Squat', 350), goal('Squat', 360)])).toEqual([]);
  });

  it('keeps apart a row already moved to a custom lift', () => {
    expect(collisions([goal('custom-lift-id', 350), goal('Back Squat', 400)])).toEqual([]);
  });
});
