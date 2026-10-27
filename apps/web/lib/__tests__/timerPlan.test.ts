import { buildTimerQueue, defaultTimerSettings } from '@lifting-logbook/core';
import type { TimerLiftPlan } from '@lifting-logbook/core';
import { emptyFocusDayState } from '@lifting-logbook/types';
import { focusRowIds, plannedRowIds } from '@/lib/focusWorkout';
import { toTimerLiftPlans } from '@/lib/timerPlan';
import type { TimerPlanInput } from '@/lib/timerPlan';
import { focusBlock, focusPlan, planGroup, planItem } from './focusPlanFixture';

function detail(lift: string, overrides: Partial<TimerPlanInput> = {}): TimerPlanInput {
  return {
    lift,
    tm: 200,
    // Required-but-nullable, so the default is explicit rather than inherited.
    activationMovement: undefined,
    plannedSets: [{ type: 'work', setLabel: 'Set 1', weight: 150, reps: 5 }],
    ...overrides,
  };
}

describe('toTimerLiftPlans', () => {
  it('formats weights and the training-max caption in the requested unit', () => {
    const [plan] = toTimerLiftPlans([detail('Bench Press')], 'lbs', [], null);

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
      null,
    );

    expect(plans.map((plan) => [plan.lift, plan.sets.length])).toEqual([
      ['Deadlift', 0],
      ['Bench Press', 1],
    ]);
  });

  it('omits the training-max caption when there is no training max', () => {
    const [plan] = toTimerLiftPlans([detail('Bench Press', { tm: 0 })], 'lbs', [], null);
    expect(plan?.tm).toBeUndefined();
  });

  describe('classification', () => {
    it('classifies built-in lifts with no custom-lift list at all', () => {
      // The two roles side by side, from one call: a mapper that hard-coded
      // either answer would satisfy half of this and fail the other half.
      const plans = toTimerLiftPlans([detail('Squat'), detail('Cable Curls')], 'lbs', [], null);

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
        null,
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
      ], null);

      expect(plans[0]?.classification).toBe('accessory');
    });

    it('leaves an unknown lift unclassified rather than dropping it', () => {
      // `undefined` is "no opinion" — the timer falls through to its preset.
      // Dropping the lift instead would silently remove it from the session.
      const plans = toTimerLiftPlans([detail('Zercher Good Morning')], 'lbs', [], null);

      expect(plans).toHaveLength(1);
      expect(plans[0]?.classification).toBeUndefined();
    });

    it('still classifies built-ins when the custom-lift list is empty', () => {
      // The shape the pages fall back to when their /lifts/custom fetch fails.
      // Paired with the success-path assertions above so this cannot be the only
      // covered branch — a fallback that quietly disabled classification
      // altogether would pass a test that asserted structure alone.
      const plans = toTimerLiftPlans([detail('Cable Curls')], 'lbs', [], null);

      expect(plans[0]?.classification).toBe('accessory');
    });
  });

  describe('focus work (#1060)', () => {
    const planned = [detail('Squat'), detail('Bench Press')];

    function order(plans: readonly TimerLiftPlan[]): string[] {
      return plans.map((plan) => plan.lift);
    }

    it('queues focus lifts after the planned lifts by default', () => {
      const plans = toTimerLiftPlans(planned, 'lbs', [], focusPlan());
      expect(order(plans)).toEqual(['Squat', 'Bench Press', 'Lateral Raise', 'Face Pull']);
    });

    it('queues them first when focus work goes before', () => {
      const plans = toTimerLiftPlans(
        planned,
        'lbs',
        [],
        focusPlan({ dayState: { ...emptyFocusDayState(), placement: 'before' } }),
      );
      expect(order(plans)).toEqual(['Lateral Raise', 'Face Pull', 'Squat', 'Bench Press']);
    });

    it('interleaves them, and follows a saved order', () => {
      const interleaved = toTimerLiftPlans(
        planned,
        'lbs',
        [],
        focusPlan({ dayState: { ...emptyFocusDayState(), placement: 'interleave' } }),
      );
      expect(order(interleaved)).toEqual(['Squat', 'Lateral Raise', 'Bench Press', 'Face Pull']);

      const [squat, bench] = plannedRowIds(['Squat', 'Bench Press']);
      const [raise, pull] = focusRowIds('b-shoulders', ['Lateral Raise', 'Face Pull']);
      const saved = toTimerLiftPlans(
        planned,
        'lbs',
        [],
        focusPlan({
          dayState: { ...emptyFocusDayState(), placement: 'interleave', order: [pull ?? '', squat ?? '', raise ?? '', bench ?? ''] },
        }),
      );
      expect(order(saved)).toEqual(['Face Pull', 'Squat', 'Lateral Raise', 'Bench Press']);
    });

    it('keeps the order of each focus block and of its lifts', () => {
      const plans = toTimerLiftPlans(
        planned,
        'lbs',
        [],
        focusPlan({
          groups: [
            planGroup({ items: [planItem('Lateral Raise'), planItem('Face Pull')] }),
            planGroup({ block: focusBlock({ id: 'b-biceps', area: 'Biceps' }), items: [planItem('Hammer Curl', 2)] }),
          ],
        }),
      );
      expect(order(plans)).toEqual(['Squat', 'Bench Press', 'Lateral Raise', 'Face Pull', 'Hammer Curl']);
    });

    it('gives a focus lift its focus block’s timer, its sets and its prescription', () => {
      const plans = toTimerLiftPlans(
        planned,
        'lbs',
        [],
        focusPlan({
          groups: [planGroup({ block: focusBlock({ timer: { prep: 5, set: 40, rest: 75 } }), items: [planItem('Lateral Raise', 2)] })],
        }),
      );
      expect(plans[2]).toEqual({
        lift: 'Lateral Raise',
        classification: 'accessory',
        durations: { prep: 5, workSet: 40, restWork: 75 },
        sets: [
          { type: 'work', setLabel: 'Set 1', spec: '10–12 reps @ 25 lbs' },
          { type: 'work', setLabel: 'Set 2', spec: '10–12 reps @ 25 lbs' },
        ],
      });
      // Planned lifts bring no durations of their own: they stay on the lifter's settings.
      expect(plans[0]?.durations).toBeUndefined();
    });

    it('times each focus lift with its own focus block’s timer in the built queue', () => {
      const plans = toTimerLiftPlans(
        [detail('Squat')],
        'lbs',
        [],
        focusPlan({
          groups: [
            planGroup({ block: focusBlock({ timer: { prep: 5, set: 40, rest: 75 } }), items: [planItem('Lateral Raise', 2)] }),
            planGroup({
              block: focusBlock({ id: 'b-biceps', area: 'Biceps', timer: { prep: 0, set: 30, rest: 45 } }),
              items: [planItem('Hammer Curl', 1)],
            }),
          ],
        }),
      );
      const queue = buildTimerQueue(plans, defaultTimerSettings());
      const phases = (lift: string) => queue.filter((p) => p.lift === lift).map((p) => [p.kind, p.dur]);

      expect(phases('Lateral Raise')).toEqual([
        ['prep', 5],
        ['set', 40],
        ['rest', 75],
        ['prep', 5],
        ['set', 40],
        ['rest', 75],
      ]);
      // A zero setup time omits the phase, and the session ends on the last set.
      expect(phases('Hammer Curl')).toEqual([['set', 30]]);
      // Each phase carries the lift's place in the plan, so the details page's rows find it.
      expect(queue.filter((p) => p.lift === 'Hammer Curl').map((p) => p.liftIndex)).toEqual([2]);
    });

    it('is the planned lifts alone for a day with no focus work', () => {
      expect(order(toTimerLiftPlans(planned, 'lbs', [], null))).toEqual(['Squat', 'Bench Press']);
    });
  });
});
