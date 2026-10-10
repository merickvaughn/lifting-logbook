import { notFound } from 'next/navigation';
import {
  fetchMacrocycleDashboard,
  fetchProgramSpec,
  fetchTrainingMaxes,
} from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import {
  buildWorkoutDays,
  computePlannedSets,
  workoutDateResolver,
  type WeekRow,
  type WorkoutCell,
} from '@/lib/workoutPlan';
import { resolveProgramPlanMeta } from '@/lib/programPlan';
import MacrocycleDashboardGrid from './MacrocycleDashboardGrid';

export default async function MacrocycleDashboardPage({
  params,
}: {
  params: Promise<{ macrocycleNum: string }>;
}) {
  const { macrocycleNum: macrocycleNumParam } = await params;
  const requestedMacrocycleNum = Number(macrocycleNumParam);
  const program = await getActiveProgram();

  const [dashboard, specs, maxes, unit] = await Promise.all([
    fetchMacrocycleDashboard(program),
    fetchProgramSpec(program),
    fetchTrainingMaxes(program),
    getPreferredUnit(),
  ]);

  if (!dashboard || dashboard.macrocycleNum !== requestedMacrocycleNum) {
    notFound();
  }

  // Grid spans the program's full canonical length (leangains 12w → 36 workout
  // days). We eagerly compute planned sets for every tiled workout here: the RSC
  // payload now scales with program length rather than a single block, a conscious
  // trade for dropping the per-workout fetch fan-out below. MacrocycleDashboardGrid only
  // mounts the current week's cards, so client render stays cheap regardless.
  const workoutDays = buildWorkoutDays(specs, dashboard.macrocycleStartDate, program);

  // Per-workout status comes entirely from the macrocycle dashboard response — no
  // per-workout fetch. `weeks` carries schedule-mode dates; the top-level maps
  // cover both modes and, crucially, the tiled week-2+ workouts a no-schedule
  // macrocycle would otherwise 400 on if fetched one-by-one (issue #740). The `?.`/`?? []`
  // guards tolerate a response missing the (required) fields — e.g. an older API
  // pod during a non-atomic web/api rolling deploy — degrading rather than crashing
  // the whole dashboard, matching how the two Sets already tolerate `undefined`.
  // Dates go through the same precedence the Program Plan's estimate uses (#1023).
  const dateOf = workoutDateResolver(dashboard);
  const skippedWorkoutNums = new Set(dashboard.skippedWorkoutNums ?? []);
  // `logged` derives from lift records (like the dashboard's own week-completion,
  // macrocycle-dashboard.controller.ts) rather than the removed per-workout response, so a
  // workout with any logged record counts as done — consistent across the dashboard.
  const completedWorkoutNums = new Set(dashboard.completedWorkoutNums ?? []);

  const today = new Date().toISOString().slice(0, 10);
  const maxMap = new Map(maxes.map((m) => [m.lift, m.weight]));

  const weekNums = [...new Set(workoutDays.map((w) => w.week))];

  const weeks: WeekRow[] = weekNums.map((week) => ({
    week,
    workouts: workoutDays
      .filter((w) => w.week === week)
      .map((w): WorkoutCell => {
        const logged = completedWorkoutNums.has(w.workoutNum);
        // Priority: user override date > API scheduled date > spec-computed date.
        const effectiveDate = dateOf(w);
        const status: WorkoutCell['status'] = logged
          ? 'completed'
          : skippedWorkoutNums.has(w.workoutNum)
            ? 'skipped'
            : effectiveDate < today
              ? 'missed'
              : 'upcoming';
        return {
          workoutNum: w.workoutNum,
          date: effectiveDate,
          status,
          lifts: w.lifts.map((spec) => ({
            name: spec.lift,
            sets: computePlannedSets(spec, maxMap.get(spec.lift) ?? 0),
          })),
        };
      }),
  }));

  // Same rule as the plan page: only a 'mesocycle'-style program groups its
  // weeks into blocks. A 'repeating' program (Leangains, RPT, custom) stays flat.
  const planMeta = resolveProgramPlanMeta(program, specs);
  const mesocycleWeeks = planMeta.phaseStyle === 'mesocycle' ? planMeta.mesocycleWeeks : 1;

  return (
    <MacrocycleDashboardGrid
      macrocycleNum={dashboard.macrocycleNum}
      weeks={weeks}
      unit={unit}
      mesocycleWeeks={mesocycleWeeks}
    />
  );
}
