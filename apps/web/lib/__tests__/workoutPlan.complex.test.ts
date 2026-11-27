import { MROUND, complexLift } from '@lifting-logbook/core';
import type { BarbellComplexResponse, LiftingProgramSpecResponse } from '@lifting-logbook/types';
import { UNKNOWN_COMPLEX, buildLiftDetails } from '../workoutPlan';

const BEAR: BarbellComplexResponse = {
  id: 'c-bear',
  name: 'Bear',
  components: [
    { lift: 'Power Clean', reps: 5, name: 'Power Clean' },
    { lift: 'Front Squat', reps: 5, name: 'Front Squat' },
    { lift: 'Push Press', reps: 5, name: 'Push Press' },
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
      found: true,
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

  it('rounds to a 10 lb increment: 70% of 135 is 94.5, planned as 90', () => {
    const maxes = [max('Power Clean', 135), max('Front Squat', 185), max('Push Press', 155)];
    const [detail] = buildLiftDetails(workout, [{ ...row, increment: 10 }], maxes, [], [BEAR]);
    expect(detail?.tm).toBe(135);
    // Every computed set rounds to the increment, the one at the max too (135 to 140).
    expect(detail?.plannedSets.map((s) => [s.type, s.weight])).toEqual([
      ['warmup', 90],
      ['work', 140],
      ['work', 90],
    ]);
  });

  it('finds a component max stored under another spelling of the lift', () => {
    const maxes = [max('Power Clean', 135), max('front-squat', 120), max('Push Press', 155)];
    const [detail] = buildLiftDetails(workout, [row], maxes, [], [BEAR]);
    expect(detail?.complex?.limitingLift).toBe('Front Squat');
    expect(detail?.tm).toBe(120);
  });

  describe('a custom lift, stored by its id', () => {
    const hangBear: BarbellComplexResponse = {
      ...BEAR,
      components: [
        { lift: 'custom-hc', reps: 3, name: 'Hang Clean' },
        { lift: 'Front Squat', reps: 5, name: 'Front Squat' },
      ],
    };

    it('plans from the max saved under its id, and names it as limiting', () => {
      const [detail] = buildLiftDetails(workout, [row], [max('custom-hc', 100), max('Front Squat', 185)], [], [hangBear]);
      expect(detail?.tm).toBe(100);
      expect(detail?.complex?.limitingLift).toBe('Hang Clean');
    });

    it('still finds a max saved under its name', () => {
      const [detail] = buildLiftDetails(workout, [row], [max('Hang Clean', 110), max('Front Squat', 185)], [], [hangBear]);
      expect(detail?.tm).toBe(110);
    });

    it('names it as missing by its id, where Set up saves the max, and shows its name', () => {
      const [detail] = buildLiftDetails(workout, [row], [max('Front Squat', 185)], [], [hangBear]);
      expect(detail?.complex?.missing).toEqual([{ lift: 'custom-hc', name: 'Hang Clean' }]);
    });
  });

  it('leaves the complex unplanned when a component has no training max, naming it', () => {
    const [detail] = buildLiftDetails(workout, [row], [max('Power Clean', 135), max('Push Press', 155)], [], [BEAR]);
    expect(detail?.complex).toMatchObject({ found: true, missing: [{ lift: 'Front Squat', name: 'Front Squat' }] });
    expect(detail?.complex?.limitingLift).toBeUndefined();
    expect(detail?.plannedSets).toEqual([]);
    expect(detail?.tm).toBe(0);
  });

  it('plans nothing for a complex it was not given, and marks it not found', () => {
    const [detail] = buildLiftDetails(workout, [row], [max('Power Clean', 135)], [], []);
    expect(detail?.complex).toEqual({ found: false, name: UNKNOWN_COMPLEX, components: [], missing: [] });
    expect(detail?.plannedSets).toEqual([]);
  });

  it('plans a complex the lifter named "Unknown complex" like any other', () => {
    const named = { ...BEAR, name: UNKNOWN_COMPLEX };
    const maxes = [max('Power Clean', 135), max('Front Squat', 185), max('Push Press', 155)];
    const [detail] = buildLiftDetails(workout, [row], maxes, [], [named]);
    expect(detail?.complex).toMatchObject({ found: true, name: UNKNOWN_COMPLEX, limitingLift: 'Power Clean' });
    expect(detail?.tm).toBe(135);
  });
});
