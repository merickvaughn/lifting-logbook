import { splitLiftRecordsByDestination } from './splitLiftRecords';
import type { LiftRecord } from '../../models';

function record(overrides: Partial<LiftRecord> = {}): LiftRecord {
  return {
    program: 'prog',
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date('2026-01-01'),
    lift: 'Squat',
    setNum: 1,
    weight: 100,
    reps: 5,
    notes: '',
    ...overrides,
  };
}

describe('splitLiftRecordsByDestination', () => {
  it('routes a 1RM-noted row to trainingMaxes', () => {
    const row = record({ lift: 'Squat', weight: 315, notes: '1RM Test' });
    const { liftRecords, trainingMaxes } = splitLiftRecordsByDestination([row]);
    expect(liftRecords).toHaveLength(0);
    expect(trainingMaxes).toHaveLength(1);
    expect(trainingMaxes[0]).toMatchObject({ lift: 'Squat', weight: 315 });
  });

  it('is case-insensitive on the 1rm marker', () => {
    const row = record({ notes: '1rm' });
    const { liftRecords, trainingMaxes } = splitLiftRecordsByDestination([row]);
    expect(liftRecords).toHaveLength(0);
    expect(trainingMaxes).toHaveLength(1);
  });

  it('keeps non-1RM rows in liftRecords', () => {
    const row = record({ notes: 'felt good' });
    const { liftRecords, trainingMaxes } = splitLiftRecordsByDestination([row]);
    expect(liftRecords).toHaveLength(1);
    expect(trainingMaxes).toHaveLength(0);
  });

  it('splits a mixed batch correctly', () => {
    const r1 = record({ lift: 'Squat', notes: '1RM', weight: 315 });
    const r2 = record({ lift: 'Bench', notes: '' });
    const r3 = record({ lift: 'Deadlift', notes: '1RM Test', weight: 400 });
    const { liftRecords, trainingMaxes } = splitLiftRecordsByDestination([r1, r2, r3]);
    expect(liftRecords).toHaveLength(1);
    expect(liftRecords[0]!.lift).toBe('Bench');
    expect(trainingMaxes).toHaveLength(2);
  });

  it('maps date from LiftRecord to dateUpdated on TrainingMax', () => {
    const date = new Date('2026-06-01');
    const row = record({ notes: '1rm', date });
    const { trainingMaxes } = splitLiftRecordsByDestination([row]);
    expect(trainingMaxes[0]!.dateUpdated).toEqual(date);
  });

  it('handles empty input', () => {
    const { liftRecords, trainingMaxes } = splitLiftRecordsByDestination([]);
    expect(liftRecords).toHaveLength(0);
    expect(trainingMaxes).toHaveLength(0);
  });
});
