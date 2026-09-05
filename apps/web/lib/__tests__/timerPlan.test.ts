import { toTimerLiftPlans } from '@/lib/timerPlan';
import type { TimerPlanInput } from '@/lib/timerPlan';

function detail(lift: string, overrides: Partial<TimerPlanInput> = {}): TimerPlanInput {
  return {
    lift,
    tm: 200,
    plannedSets: [{ type: 'work', setLabel: 'Set 1', weight: 150, reps: 5 }],
    ...overrides,
  };
}

describe('toTimerLiftPlans', () => {
  it('formats weights and the training-max caption in the requested unit', () => {
    const [plan] = toTimerLiftPlans([detail('Bench Press')], 'lbs', []);

    expect(plan?.lift).toBe('Bench Press');
    expect(plan?.tm).toBe('TM: 200 lbs');
    expect(plan?.sets).toEqual([{ type: 'work', setLabel: 'Set 1', spec: '5 × 150 lbs' }]);
  });

  it('keeps a lift with no planned sets as an empty plan, so positions stay aligned', () => {
    // Position is a lift occurrence's identity for the timer (issue #980): a
    // dropped entry would shift every later lift's `liftIndex` away from the
    // page's own list. An empty plan contributes no phases either way.
    const plans = toTimerLiftPlans(
      [detail('Deadlift', { plannedSets: [] }), detail('Bench Press')],
      'lbs',
      [],
    );

    expect(plans.map((plan) => [plan.lift, plan.sets.length])).toEqual([
      ['Deadlift', 0],
      ['Bench Press', 1],
    ]);
  });

  it('omits the training-max caption when there is no training max', () => {
    const [plan] = toTimerLiftPlans([detail('Bench Press', { tm: 0 })], 'lbs', []);
    expect(plan?.tm).toBeUndefined();
  });

  describe('classification', () => {
    it('classifies built-in lifts with no custom-lift list at all', () => {
      // The two roles side by side, from one call: a mapper that hard-coded
      // either answer would satisfy half of this and fail the other half.
      const plans = toTimerLiftPlans([detail('Squat'), detail('Cable Curls')], 'lbs', []);

      expect(plans.map((plan) => [plan.lift, plan.classification])).toEqual([
        ['Squat', 'compound'],
        ['Cable Curls', 'accessory'],
      ]);
    });

    it('classifies a lift named the way a custom program names it', () => {
      // ProgramEditor's exercise picker is built from `LIFT_CATALOG.map(l => l.name)`
      // and stores the selection verbatim, so a custom program's lifts arrive here
      // as catalog display names — a different vocabulary from the built-in
      // templates' slot names, and the one the first implementation missed
      // entirely for 15 of 23 lifts.
      const plans = toTimerLiftPlans(
        [detail('Cable Curl'), detail('Lateral Raise'), detail('Back Squat')],
        'lbs',
        [],
      );

      expect(plans.map((plan) => [plan.lift, plan.classification])).toEqual([
        ['Cable Curl', 'accessory'],
        ['Lateral Raise', 'accessory'],
        ['Back Squat', 'compound'],
      ]);
    });

    it('classifies a custom lift from the list it is given', () => {
      const plans = toTimerLiftPlans([detail('Sissy Squat')], 'lbs', [
        { name: 'Sissy Squat', classification: 'accessory' },
      ]);

      expect(plans[0]?.classification).toBe('accessory');
    });

    it('leaves an unknown lift unclassified rather than dropping it', () => {
      // `undefined` is "no opinion" — the timer falls through to its preset.
      // Dropping the lift instead would silently remove it from the session.
      const plans = toTimerLiftPlans([detail('Zercher Good Morning')], 'lbs', []);

      expect(plans).toHaveLength(1);
      expect(plans[0]?.classification).toBeUndefined();
    });

    it('still classifies built-ins when the custom-lift list is empty', () => {
      // The shape the pages fall back to when their /lifts/custom fetch fails.
      // Paired with the success-path assertions above so this cannot be the only
      // covered branch — a fallback that quietly disabled classification
      // altogether would pass a test that asserted structure alone.
      const plans = toTimerLiftPlans([detail('Cable Curls')], 'lbs', []);

      expect(plans[0]?.classification).toBe('accessory');
    });
  });
});
