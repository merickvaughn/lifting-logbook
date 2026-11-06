import { focusPlan, planGroup, planItem } from '@/lib/__tests__/focusPlanFixture';
import { hasLoggedFocusWork, withFocusLifts } from './focusLifts';
import type { LiftData } from './types';

const logged = (lift: string, setNum = 1): LiftData => ({
  lift,
  isBodyweightComponent: false,
  warmUpSets: [],
  workingSets: [
    { setNum, totalLoad: 100, reps: 10, amrap: false, existing: { id: `${lift}-${setNum}`, weight: 100, reps: 10, notes: '' } },
  ],
});

const planFor = (focusLift: string, plannedLifts: string[]) =>
  focusPlan({ plannedLifts, groups: [planGroup({ items: [planItem(focusLift)] })] });

// #1135: focus sets can be stored by catalog id while the pool names the lift.
describe('withFocusLifts across stored spellings', () => {
  it('folds sets stored by catalog id back into their focus lift', () => {
    const lifts = withFocusLifts([logged('Back Squat'), logged('bench-press')], planFor('Bench Press', ['Back Squat']), 'lbs');
    expect(lifts.map((l) => l.lift)).toEqual(['Back Squat', 'Bench Press']);
    expect(lifts[1]?.workingSets[0]?.existing?.id).toBe('bench-press-1');
    expect(hasLoggedFocusWork([logged('bench-press')], planFor('Bench Press', []))).toBe(true);
  });

  it('keeps an id row listed when the workout already lists the lift by name', () => {
    const lifts = withFocusLifts(
      [logged('Bench Press'), logged('bench-press')],
      planFor('Bench Press', ['Bench Press']),
      'lbs',
    );
    expect(lifts.map((l) => l.lift)).toEqual(['Bench Press', 'bench-press']);
  });
});
