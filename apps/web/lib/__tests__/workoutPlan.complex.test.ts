import { MROUND, complexLift } from '@lifting-logbook/core';
import type { BarbellComplexResponse, LiftingProgramSpecResponse } from '@lifting-logbook/types';
import { UNKNOWN_COMPLEX, buildLiftDetails } from '../workoutPlan';

const BEAR: BarbellComplexResponse = {
  id: 'c-bear',
  name: 'Bear',
  components: [
    { lift: 'Power Clean', reps: 5 },
    { lift: 'Front Squat', reps: 5 },
    { lift: 'Push Press', reps: 5 },
  ],
  createdAt: '2026-11-27T00:00:00.000Z',
};

/** A row planning the complex: one warm-up at 70%, then a set at the max and one at 70%. */
const row: LiftingProgramSpecResponse = {
  week: 1,
  lift: complexLift(BEAR.id),
  order: 1,
  offset: 0,
  increment: 5,
  sets: 2,
  reps: 1,
  amrap: false,
  warmUpPct: '0.7',
  wtDecrementPct: 0.3,
  activation: '',
};

const workout = { week: 1, offset: 0, lifts: [{ lift: complexLift(BEAR.id), sets: [], planned: true }] };
const max = (lift: string, weight: number) => ({ lift, weight, dateUpdated: '2026-11-20' });

describe('buildLiftDetails — a row naming a complex plans from its weakest lift (#1495)', () => {
  it('plans 70% of the lowest component max, rounded to the increment, and names that lift as limiting', () => {
    const maxes = [max('Power Clean', 135), max('Front Squat', 185), max('Push Press', 155)];
    const [detail] = buildLiftDetails(workout, [row], maxes, [], [BEAR]);

    const seventyPct = MROUND(135 * 0.7, 5);
    expect(seventyPct).toBe(95);
    expect(detail?.tm).toBe(135);
    expect(detail?.complex).toEqual({
      name: 'Bear',
      components: BEAR.components,
      limitingLift: 'Power Clean',
      missing: [],
    });
    expect(detail?.plannedSets.map((s) => [s.type, s.weight])).toEqual([
      ['warmup', seventyPct],
      ['work', 135],
      ['work', seventyPct],
    ]);
  });

  it('finds a component max stored under another spelling of the lift', () => {
    const maxes = [max('Power Clean', 135), max('front-squat', 120), max('Push Press', 155)];
    const [detail] = buildLiftDetails(workout, [row], maxes, [], [BEAR]);
    expect(detail?.complex?.limitingLift).toBe('Front Squat');
    expect(detail?.tm).toBe(120);
  });

  it('leaves the complex unplanned when a component has no training max, naming it', () => {
    const [detail] = buildLiftDetails(workout, [row], [max('Power Clean', 135), max('Push Press', 155)], [], [BEAR]);
    expect(detail?.complex).toMatchObject({ missing: ['Front Squat'] });
    expect(detail?.complex?.limitingLift).toBeUndefined();
    expect(detail?.plannedSets).toEqual([]);
    expect(detail?.tm).toBe(0);
  });

  it('plans nothing for a complex it was not given, and names it as unknown', () => {
    const [detail] = buildLiftDetails(workout, [row], [max('Power Clean', 135)], [], []);
    expect(detail?.complex).toEqual({ name: UNKNOWN_COMPLEX, components: [], missing: [] });
    expect(detail?.plannedSets).toEqual([]);
  });
});
