import { LiftRecord } from '@lifting-logbook/core';
import { InMemoryWorkoutRepository } from './workout.adapter';

describe('InMemoryWorkoutRepository.saveWorkout', () => {
  it("keeps its sets' modifications", async () => {
    const repo = new InMemoryWorkoutRepository(new Map());
    const record: LiftRecord = {
      program: 'p',
      macrocycleNum: 1,
      workoutNum: 1,
      date: new Date('2026-04-20T00:00:00.000Z'),
      lift: 'bench-press',
      setNum: 1,
      weight: 180,
      reps: 5,
      notes: '',
      modifications: ['paused-id'],
    };

    await repo.saveWorkout('p', 1, 1, [record]);

    const [saved] = await repo.getWorkout('p', 1, 1);
    expect(saved?.modifications).toEqual(['paused-id']);
  });
});
