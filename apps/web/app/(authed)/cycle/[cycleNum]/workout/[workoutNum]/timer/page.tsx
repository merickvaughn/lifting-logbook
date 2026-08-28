import { notFound } from 'next/navigation';
import { fetchWorkout, fetchProgramSpec, fetchTrainingMaxes } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import { computePlannedSets } from '@/lib/workoutPlan';
import { toTimerLiftPlans } from '@/lib/timerPlan';
import WorkoutTimerView from './WorkoutTimerView';

/**
 * The timed-session page.
 *
 * Mirrors the workout-detail page's fetch-and-compute shape deliberately: the
 * plan the timer counts down must be the same plan the detail page displays, so
 * both derive it from `computePlannedSets` rather than from two code paths that
 * could drift.
 */
export default async function WorkoutTimerPage({
  params,
}: {
  params: Promise<{ cycleNum: string; workoutNum: string }>;
}) {
  const { cycleNum: cycleNumParam, workoutNum: workoutNumParam } = await params;
  const cycleNum = Number(cycleNumParam);
  const workoutNum = Number(workoutNumParam);

  if (!Number.isInteger(cycleNum) || !Number.isInteger(workoutNum) || workoutNum < 1) {
    notFound();
  }

  const program = await getActiveProgram();

  const [workout, specs, maxes, unit] = await Promise.all([
    fetchWorkout(program, workoutNum),
    fetchProgramSpec(program),
    fetchTrainingMaxes(program),
    getPreferredUnit(),
  ]);

  if (!workout) {
    notFound();
    return null;
  }

  const maxMap = new Map(maxes.map((m) => [m.lift, m.weight]));

  const liftDetails = workout.lifts.map((wl) => {
    const tm = maxMap.get(wl.lift) ?? 0;
    const spec = specs.find((s) => s.week === workout.week && s.lift === wl.lift);
    return { lift: wl.lift, tm, plannedSets: spec ? computePlannedSets(spec, tm) : [] };
  });

  return (
    <WorkoutTimerView
      lifts={toTimerLiftPlans(liftDetails, unit)}
      program={program}
      cycleNum={cycleNum}
      workoutNum={workoutNum}
      week={workout.week}
    />
  );
}
