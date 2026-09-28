import { InMemoryWorkoutLiftOverrideRepository } from './workout-lift-override.adapter';

const W = ['5-3-1', 2, 7] as const;

describe('InMemoryWorkoutLiftOverrideRepository', () => {
  it('keeps a lift’s add when the lift is replaced (#1026)', async () => {
    // Replacing an added lift used to overwrite its add, leaving the replace
    // with no lift to swap: neither lift was planned.
    const repo = new InMemoryWorkoutLiftOverrideRepository();
    await repo.upsertOverride(...W, { lift: 'Chin-up', action: 'add' });
    await repo.upsertOverride(...W, { lift: 'Chin-up', action: 'replace', replacedBy: 'Pull-up' });

    expect(await repo.getOverrides(...W)).toEqual([
      { lift: 'Chin-up', action: 'add' },
      { lift: 'Chin-up', action: 'replace', replacedBy: 'Pull-up' },
    ]);
  });

  it('keeps a lift’s replace when the lift is then added', async () => {
    // Squat swapped for Front Squat, then Squat added back: the add used to
    // overwrite the replace, undoing the swap.
    const repo = new InMemoryWorkoutLiftOverrideRepository();
    await repo.upsertOverride(...W, { lift: 'Squat', action: 'replace', replacedBy: 'Front Squat' });
    await repo.upsertOverride(...W, { lift: 'Squat', action: 'add' });

    expect(await repo.getOverrides(...W)).toEqual([
      { lift: 'Squat', action: 'replace', replacedBy: 'Front Squat' },
      { lift: 'Squat', action: 'add' },
    ]);
  });

  it('replaces the lift’s override of the same kind, moving it to the end (#1014)', async () => {
    const repo = new InMemoryWorkoutLiftOverrideRepository();
    await repo.upsertOverride(...W, { lift: 'Chin-up', action: 'add' });
    await repo.upsertOverride(...W, { lift: 'Squat', action: 'replace', replacedBy: 'Front Squat' });
    await repo.upsertOverride(...W, { lift: 'Chin-up', action: 'replace', replacedBy: 'Pull-up' });
    // A remove and an add are one kind: whether the workout has the lift.
    await repo.upsertOverride(...W, { lift: 'Chin-up', action: 'remove' });
    // A lift keeps one replace.
    await repo.upsertOverride(...W, { lift: 'Squat', action: 'replace', replacedBy: 'Box Squat' });

    expect(await repo.getOverrides(...W)).toEqual([
      { lift: 'Chin-up', action: 'replace', replacedBy: 'Pull-up' },
      { lift: 'Chin-up', action: 'remove' },
      { lift: 'Squat', action: 'replace', replacedBy: 'Box Squat' },
    ]);
  });

  it('deletes every override of a lift, of either kind', async () => {
    const repo = new InMemoryWorkoutLiftOverrideRepository();
    await repo.upsertOverride(...W, { lift: 'Chin-up', action: 'add' });
    await repo.upsertOverride(...W, { lift: 'Chin-up', action: 'replace', replacedBy: 'Pull-up' });
    await repo.upsertOverride(...W, { lift: 'Face Pulls', action: 'add' });

    await repo.deleteOverride(...W, 'Chin-up');

    expect(await repo.getOverrides(...W)).toEqual([{ lift: 'Face Pulls', action: 'add' }]);
  });
});
