import type { FocusDayPlanResponse, FocusPlanGroupResponse, FocusPlanItemResponse, WeightUnit } from '@lifting-logbook/types';
import { describePrescription, prescribedSet, workoutOrder } from '@/lib/focusWorkout';
import type { LiftData, WorkingSetData } from './types';

/** Every set of one focus lift: its prescription, plus any already logged beyond it. */
function focusLift(
  group: FocusPlanGroupResponse,
  item: FocusPlanItemResponse,
  logged: LiftData | undefined,
  unit: WeightUnit,
): LiftData {
  const { weight, reps } = prescribedSet(item.prescription);
  const existing = new Map((logged?.workingSets ?? []).map((set) => [set.setNum, set]));
  const workingSets: WorkingSetData[] = Array.from({ length: item.sets }, (_, k) => {
    const setNum = k + 1;
    const record = existing.get(setNum)?.existing;
    return { setNum, totalLoad: weight, reps, amrap: false, ...(record && { existing: record }) };
  });
  // A set logged before the focus block was reduced or trimmed for today stays visible.
  for (const set of logged?.workingSets ?? []) if (set.setNum > item.sets) workingSets.push(set);
  return {
    lift: item.lift,
    isBodyweightComponent: false,
    warmUpSets: [],
    workingSets,
    focus: { area: group.block.area, summary: describePrescription(item.prescription, unit).summary },
  };
}

/**
 * The workout's lifts with the day's focus work (#1060), in the order the workout details
 * page and the timer use (`workoutOrder`).
 *
 * Focus sets are logged as ordinary lift records against this workout, which the API then
 * returns as extra lifts not in the plan. Such a lift is folded back into its focus entry,
 * so a half-logged focus lift shows its logged sets and the ones still to do, once.
 *
 * A focus lift already listed (a planned lift of the same name, or a second focus block
 * with the same lift) is left out: lift records are keyed by lift and set number, so a
 * second entry would log onto the first one's sets.
 */
export function withFocusLifts(lifts: readonly LiftData[], plan: FocusDayPlanResponse, unit: WeightUnit): LiftData[] {
  const plannedNames = new Set(plan.plannedLifts);
  const focusNames = new Set(plan.groups.flatMap((group) => group.items.map((item) => item.lift)));
  const loggedFocus = new Map<string, LiftData>();
  const base: LiftData[] = [];
  for (const lift of lifts) {
    if (!plannedNames.has(lift.lift) && focusNames.has(lift.lift)) loggedFocus.set(lift.lift, lift);
    else base.push(lift);
  }

  const listed = new Set(base.map((lift) => lift.lift));
  return workoutOrder(
    base.map((lift) => lift.lift),
    plan.groups,
    plan.dayState,
  ).flatMap((entry): LiftData[] => {
    if (entry.kind === 'planned') {
      const lift = base[entry.liftIndex];
      return lift ? [lift] : [];
    }
    if (listed.has(entry.item.lift)) return [];
    listed.add(entry.item.lift);
    return [focusLift(entry.group, entry.item, loggedFocus.get(entry.item.lift), unit)];
  });
}

/** True when the plan has a focus lift the workout already has logged sets for. */
export function hasLoggedFocusWork(lifts: readonly LiftData[], plan: FocusDayPlanResponse): boolean {
  const plannedNames = new Set(plan.plannedLifts);
  const focusNames = new Set(plan.groups.flatMap((group) => group.items.map((item) => item.lift)));
  return lifts.some(
    (lift) => !plannedNames.has(lift.lift) && focusNames.has(lift.lift) && lift.workingSets.some((s) => s.existing),
  );
}
