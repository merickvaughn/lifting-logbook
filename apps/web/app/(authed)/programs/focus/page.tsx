import {
  fetchCustomLifts,
  fetchMacrocycleDashboard,
  fetchProgramSpec,
} from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import { buildWorkoutDays, workoutDateResolver } from '@/lib/workoutPlan';
import type { FocusWeekWorkout } from '@/lib/focusSetup';
import FocusSetup from './FocusSetup';

/**
 * Focus work setup (#1057). The program context — its lifts and the current macrocycle's
 * workouts — loads here; the focus blocks themselves load in the browser, because their
 * status depends on the user's calendar day.
 */
export default async function FocusPage() {
  const program = await getActiveProgram();
  const [dashboard, specs, customLifts, unit] = await Promise.all([
    fetchMacrocycleDashboard(program),
    fetchProgramSpec(program),
    fetchCustomLifts(),
    getPreferredUnit(),
  ]);

  // A spec row can name a custom lift by its uuid; focus pools and rules name lifts.
  const nameById = new Map(customLifts.map((lift) => [lift.id, lift.name] as const));
  const programLifts = [...new Set(specs.map((spec) => nameById.get(spec.lift) ?? spec.lift))];

  let workouts: FocusWeekWorkout[] = [];
  if (dashboard) {
    const dateOf = workoutDateResolver(dashboard);
    // Guarded like the Macrocycle Dashboard's: an older API pod during a rolling deploy can
    // omit these fields, and the page degrades to "not done" rather than failing to render.
    // Display-only, so no data-level test distinguishes it (skewed-test rule, option c).
    const done = new Set([...(dashboard.completedWorkoutNums ?? []), ...(dashboard.skippedWorkoutNums ?? [])]);
    workouts = buildWorkoutDays(specs, dashboard.macrocycleStartDate, program).map((day) => ({
      workoutNum: day.workoutNum,
      week: day.week,
      date: dateOf(day),
      done: done.has(day.workoutNum),
    }));
  }

  return (
    <FocusSetup
      program={program}
      macrocycleNum={dashboard ? dashboard.macrocycleNum : null}
      programLifts={programLifts}
      workouts={workouts}
      unit={unit}
    />
  );
}
