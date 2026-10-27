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
 * Whether a workout lift is a focus lift's logged sets: focus sets are logged as ordinary
 * lift records against the workout, which the API returns as an extra lift not in the plan.
 */
function isLoggedFocusLift(lift: LiftData, plan: FocusDayPlanResponse): boolean {
  return (
    !plan.plannedLifts.includes(lift.lift) &&
    plan.groups.some((group) => group.items.some((item) => item.lift === lift.lift))
  );
}

/**
 * The workout's lifts with the day's focus work (#1060), in the order the workout details
 * page and the timer use (`workoutOrder`, which also leaves out a focus lift already
 * listed under the same name).
 *
 * A focus lift's logged sets are folded back into its focus entry, so a half-logged focus
 * lift shows its logged sets and the ones still to do, once.
 */
export function withFocusLifts(lifts: readonly LiftData[], plan: FocusDayPlanResponse, unit: WeightUnit): LiftData[] {
  const loggedFocus = new Map<string, LiftData>();
  const base: LiftData[] = [];
  for (const lift of lifts) {
    if (isLoggedFocusLift(lift, plan)) loggedFocus.set(lift.lift, lift);
    else base.push(lift);
  }

  return workoutOrder(
    base.map((lift) => lift.lift),
    plan.groups,
    plan.dayState,
  ).flatMap((entry): LiftData[] => {
    if (entry.kind === 'planned') {
      const lift = base[entry.liftIndex];
      return lift ? [lift] : [];
    }
    return [focusLift(entry.group, entry.item, loggedFocus.get(entry.item.lift), unit)];
  });
}

/** True when the workout already has logged sets for one of the plan's focus lifts. */
export function hasLoggedFocusWork(lifts: readonly LiftData[], plan: FocusDayPlanResponse): boolean {
  return lifts.some((lift) => isLoggedFocusLift(lift, plan) && lift.workingSets.some((s) => s.existing));
}
