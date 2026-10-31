import { InMemoryWorkoutDateOverrideRepository } from './workout-date-override.adapter';

describe('InMemoryWorkoutDateOverrideRepository', () => {
  it('deletes every override of a program across macrocycles, leaving other programs alone (#1084)', async () => {
    const repo = new InMemoryWorkoutDateOverrideRepository();
    const date = new Date('2026-09-01T00:00:00Z');
    await repo.upsertOverride('5-3-1', 1, 1, date);
    await repo.upsertOverride('5-3-1', 2, 3, date);
    await repo.upsertOverride('leangains', 1, 1, date);

    await repo.deleteAllOverrides('5-3-1');

    expect((await repo.getOverridesForMacrocycle('5-3-1', 1)).size).toBe(0);
    expect((await repo.getOverridesForMacrocycle('5-3-1', 2)).size).toBe(0);
    expect(await repo.getOverride('leangains', 1, 1)).toEqual(date);
  });
});
