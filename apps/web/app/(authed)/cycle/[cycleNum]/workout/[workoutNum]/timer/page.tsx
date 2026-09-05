import { notFound, redirect } from 'next/navigation';
import { getActiveProgram } from '@/lib/active-program';
import { loadWorkoutPlan } from '@/lib/loadWorkoutPlan';
import { isTimeable } from '@/lib/workoutStatus';
import WorkoutTimerView from './WorkoutTimerView';

/**
 * The timed-session page.
 *
 * The plan the timer counts down must be the same plan the detail page
 * displays, so both take it from `loadWorkoutPlan` — one code path, nothing to
 * keep in step (issue #984).
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
  const plan = await loadWorkoutPlan(program, workoutNum);

  if (!plan) {
    notFound();
    return null;
  }

  // The detail page declines to mount the timer for a finished or skipped
  // workout; this route has to agree, or it would hand out a fully working timer
  // for a session that is already done — and a run started here would then have
  // no dock on the detail page able to end it.
  if (!isTimeable(plan.status)) {
    redirect(`/cycle/${cycleNum}/workout/${workoutNum}/detail`);
  }

  return (
    <WorkoutTimerView
      lifts={await plan.timerLifts()}
      program={program}
      cycleNum={cycleNum}
      workoutNum={workoutNum}
      week={plan.workout.week}
    />
  );
}
