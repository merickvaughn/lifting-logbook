import { notFound, redirect } from 'next/navigation';
import { fetchWorkout, fetchProgramSpec, fetchTrainingMaxes, fetchCustomLifts } from '@/lib/api';
import { withTimeout } from '@/lib/with-timeout';
import { CUSTOM_LIFTS_TIMEOUT_MS } from '@/lib/timerPlan';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import { computePlannedSets } from '@/lib/workoutPlan';
import { toTimerLiftPlans } from '@/lib/timerPlan';
import { isTimeable, statusOf } from '@/lib/workoutStatus';
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

  const [workout, specs, maxes, unit, customLifts] = await Promise.all([
    fetchWorkout(program, workoutNum),
    fetchProgramSpec(program),
    fetchTrainingMaxes(program),
    getPreferredUnit(),
    // Bounded and caught, unlike its four siblings: this one only enriches the
    // accessory classification of the user's *own* lifts, so neither a failure
    // nor a slow response may take down — or hold up — a timer the lifter is
    // standing in the gym waiting on. The other four are load-bearing and keep
    // their fail-fast behavior.
    //
    // The timeout is separate from the api-client's own `AbortSignal.timeout(30s)`:
    // that is a failure bound, and 30s of blocked first paint for an optional
    // enrichment is not a useful outcome. `onTimeout` logs distinctly so "slow"
    // and "down" stay tellable apart in the logs.
    // fallback-covered-by: apps/web/app/(authed)/cycle/[cycleNum]/workout/[workoutNum]/timer/page.test.tsx
    withTimeout(
      fetchCustomLifts().catch((err: unknown) => {
        console.error(
          'WorkoutTimerPage: custom lifts fetch failed, classifying built-ins only',
          err,
        );
        return [];
      }),
      CUSTOM_LIFTS_TIMEOUT_MS,
      [],
      () =>
        console.warn('WorkoutTimerPage: custom lifts fetch slow, classifying built-ins only'),
    ),
  ]);

  if (!workout) {
    notFound();
    return null;
  }

  // The detail page declines to mount the timer for a finished or skipped
  // workout; this route has to agree, or it would hand out a fully working timer
  // for a session that is already done — and a run started here would then have
  // no dock on the detail page able to end it.
  if (!isTimeable(statusOf(workout))) {
    redirect(`/cycle/${cycleNum}/workout/${workoutNum}/detail`);
  }

  const maxMap = new Map(maxes.map((m) => [m.lift, m.weight]));

  const liftDetails = workout.lifts.map((wl) => {
    const tm = maxMap.get(wl.lift) ?? 0;
    const spec = specs.find((s) => s.week === workout.week && s.lift === wl.lift);
    return { lift: wl.lift, tm, plannedSets: spec ? computePlannedSets(spec, tm) : [] };
  });

  return (
    <WorkoutTimerView
      lifts={toTimerLiftPlans(liftDetails, unit, customLifts)}
      program={program}
      cycleNum={cycleNum}
      workoutNum={workoutNum}
      week={workout.week}
    />
  );
}
