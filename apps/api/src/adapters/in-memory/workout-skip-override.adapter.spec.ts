import { InMemoryWorkoutSkipOverrideRepository } from './workout-skip-override.adapter';

describe('InMemoryWorkoutSkipOverrideRepository', () => {
  it('deletes every skip of a program across macrocycles, leaving other programs alone (#1084)', async () => {
    const repo = new InMemoryWorkoutSkipOverrideRepository();
    await repo.skipWorkout('5-3-1', 1, 2);
    await repo.skipWorkout('5-3-1', 2, 4);
    await repo.skipWorkout('5-3-1-bbb', 1, 2);

    await repo.deleteAllSkips('5-3-1');

    expect(await repo.getSkipsForMacrocycle('5-3-1', 1)).toEqual(new Set());
    expect(await repo.getSkipsForMacrocycle('5-3-1', 2)).toEqual(new Set());
    expect(await repo.getSkipsForMacrocycle('5-3-1-bbb', 1)).toEqual(new Set([2]));
  });
});
