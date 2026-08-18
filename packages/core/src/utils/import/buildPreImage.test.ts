import { buildLiftRecordsPreImage, buildTrainingMaxPreImage, buildStrengthGoalPreImage } from './buildPreImage';
import type { LiftRecord, TrainingMax, StrengthGoalEntry } from '../../models';

function liftRecord(overrides: Partial<LiftRecord> = {}): LiftRecord {
  return {
    program: 'prog', cycleNum: 1, workoutNum: 1, date: new Date('2026-01-01'),
    lift: 'Squat', setNum: 1, weight: 100, reps: 5, notes: '',
    ...overrides,
  };
}

function trainingMax(lift: string, weight: number): TrainingMax {
  return { lift, weight, dateUpdated: new Date('2026-01-01') };
}

function goal(lift: string, overrides: Partial<StrengthGoalEntry> = {}): StrengthGoalEntry {
  return { lift, goalType: 'absolute', target: 315, unit: 'lbs', updatedAt: new Date(), ...overrides };
}

describe('buildLiftRecordsPreImage', () => {
  it('records each created row with kind created and wrote payload', () => {
    const r = liftRecord({ weight: 200, reps: 3, notes: 'heavy' });
    const image = buildLiftRecordsPreImage([r]);
    const key = Object.keys(image)[0]!;
    expect(image[key]!.kind).toBe('created');
    expect(image[key]!.wrote).toMatchObject({ weight: 200, reps: 3, notes: 'heavy' });
  });

  it('deduplicates rows with the same natural key', () => {
    const r = liftRecord();
    const image = buildLiftRecordsPreImage([r, r]);
    expect(Object.keys(image)).toHaveLength(1);
  });

  // Regression for issue #884: two rows sharing every field except date are
  // different records and must both get their own pre-image entry, not
  // collapse into one the way a true same-key duplicate does.
  it('keeps separate entries for rows with the same key but different dates', () => {
    const a = liftRecord({ date: new Date('2025-12-16'), weight: 175 });
    const b = liftRecord({ date: new Date('2024-01-12'), weight: 202.5 });
    const image = buildLiftRecordsPreImage([a, b]);
    expect(Object.keys(image)).toHaveLength(2);
  });

  it('returns empty image for empty input', () => {
    expect(buildLiftRecordsPreImage([])).toEqual({});
  });
});

describe('buildTrainingMaxPreImage', () => {
  it('marks a new lift as created with no before field', () => {
    const incoming = [trainingMax('Squat', 315)];
    const existing: TrainingMax[] = [];
    const image = buildTrainingMaxPreImage(incoming, existing);
    expect(image['Squat']!.kind).toBe('created');
    expect(image['Squat']!.before).toBeUndefined();
    expect(image['Squat']!.wrote).toEqual({ weight: 315, dateUpdated: '2026-01-01T00:00:00.000Z' });
  });

  it('marks an updated lift as updated with before and wrote including dateUpdated', () => {
    const incoming = [trainingMax('Squat', 320)];
    const existing = [trainingMax('Squat', 300)];
    const image = buildTrainingMaxPreImage(incoming, existing);
    expect(image['Squat']!.kind).toBe('updated');
    expect(image['Squat']!.before).toEqual({ weight: 300, dateUpdated: '2026-01-01T00:00:00.000Z' });
    expect(image['Squat']!.wrote).toEqual({ weight: 320, dateUpdated: '2026-01-01T00:00:00.000Z' });
  });

  it('omits unchanged (skipped) lifts', () => {
    const incoming = [trainingMax('Squat', 300)];
    const existing = [trainingMax('Squat', 300)];
    const image = buildTrainingMaxPreImage(incoming, existing);
    expect(image['Squat']).toBeUndefined();
  });
});

describe('buildStrengthGoalPreImage', () => {
  it('marks a new goal as created', () => {
    const incoming = [goal('Squat')];
    const image = buildStrengthGoalPreImage(incoming, []);
    expect(image['Squat']!.kind).toBe('created');
    expect(image['Squat']!.wrote).toMatchObject({ goalType: 'absolute', target: 315, unit: 'lbs' });
  });

  it('marks an updated goal as updated with before', () => {
    const incoming = [goal('Squat', { target: 350 })];
    const existing = [goal('Squat', { target: 315 })];
    const image = buildStrengthGoalPreImage(incoming, existing);
    expect(image['Squat']!.kind).toBe('updated');
    expect((image['Squat']!.before as Record<string, unknown>)['target']).toBe(315);
    expect((image['Squat']!.wrote as Record<string, unknown>)['target']).toBe(350);
  });
});
