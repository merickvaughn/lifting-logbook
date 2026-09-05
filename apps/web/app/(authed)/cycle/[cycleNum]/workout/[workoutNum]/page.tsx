import { notFound } from 'next/navigation';
import {
  LIFT_CATALOG,
  MROUND,
  PROG_SPEC_WARMUP_PCTS,
  WARMUP_BASE_REPS,
  DEFAULT_SLOT_MAP,
  convertWeight,
} from '@lifting-logbook/core';
import {
  fetchLatestBodyWeight,
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchWorkout,
} from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import WorkoutLogger from './WorkoutLogger';
import type { LiftData, WarmUpSetData, WorkingSetData, WorkoutLoggerProps } from './types';

/**
 * Hard-coded warm-up implement names for bodyweight-component exercises.
 * Follow-on: make these configurable per exercise (see proposal open questions).
 */
const WARMUP_IMPLEMENT: Record<string, string> = {
  'Chin-up': 'lat pulldown',
  'Pull-up': 'lat pulldown',
  'Dips': 'dips (unweighted)',
};

function isBodyweightComponent(liftName: string): boolean {
  const catalogId = DEFAULT_SLOT_MAP[liftName];
  if (!catalogId) return false;
  return LIFT_CATALOG.find((l) => l.id === catalogId)?.isBodyweightComponent ?? false;
}

export default async function WorkoutLoggingPage({
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

  const [workout, specs, maxes, latestBodyWeight, unit] = await Promise.all([
    fetchWorkout(program, workoutNum),
    fetchProgramSpec(program),
    fetchTrainingMaxes(program),
    fetchLatestBodyWeight(program),
    getPreferredUnit(),
  ]);

  if (!workout) {
    notFound();
    return null; // unreachable; notFound() throws but TypeScript can't verify without Next.js types
  }

  const maxMap = new Map(maxes.map((m) => [m.lift, m.weight]));

  const lifts: LiftData[] = workout.lifts.map((wl) => {
    const tm = maxMap.get(wl.lift) ?? 0;

    // Spec entry for this (week, lift) — provides warmUpPct and increment
    const spec = specs.find((s) => s.week === workout.week && s.lift === wl.lift);

    const warmUpSets: WarmUpSetData[] = spec
      ? PROG_SPEC_WARMUP_PCTS(spec.warmUpPct)
          .filter((p) => !isNaN(p) && p > 0)
          .map((pct, i) => ({
            reps: Math.max(1, WARMUP_BASE_REPS - i),
            totalLoad: MROUND(tm * pct, spec.increment),
          }))
      : [];

    // `planned: false` is the API's contract for "these sets are logged records"
    // (`planned: true` lifts carry no sets on the real API). Each such set now
    // brings its own record id and notes (issue #978), so the page no longer
    // fetches the whole cycle's lift records just to look them up — which also
    // fixes a `replace`-override edge: the old name-based `.find` missed a
    // renamed lift's records, showing its logged sets as unlogged.
    const workingSets: WorkingSetData[] = wl.sets.map((s) => ({
      setNum: s.setNum,
      totalLoad: s.weight,
      reps: s.reps,
      amrap: s.amrap,
      existing: wl.planned ? undefined : { id: s.id, weight: s.weight, reps: s.reps, notes: s.notes },
    }));

    const bwComponent = isBodyweightComponent(wl.lift);

    return {
      lift: wl.lift,
      isBodyweightComponent: bwComponent,
      warmUpImplement: bwComponent ? WARMUP_IMPLEMENT[wl.lift] : undefined,
      warmUpSets,
      workingSets,
    };
  });

  const hasBodyweightComponent = lifts.some((l) => l.isBodyweightComponent);

  // A workout is read-only when every working set across every lift has a logged record.
  const totalWorkingSets = lifts.reduce((n, l) => n + l.workingSets.length, 0);
  const loggedCount = lifts.reduce(
    (n, l) => n + l.workingSets.filter((s) => s.existing).length,
    0,
  );
  const isReadOnly = totalWorkingSets > 0 && loggedCount === totalWorkingSets;

  // Re-use a same-day body weight so the gate doesn't re-fire mid-session.
  // If the stored entry is from a different day, pass null → gate fires again.
  // Body weight may be stored in kg, but WorkoutLogger's added-load math runs in
  // lbs, so normalize to lbs here (the per-record unit is preserved server-side).
  const initialBodyWeight =
    latestBodyWeight && latestBodyWeight.date === workout.date
      ? convertWeight(latestBodyWeight.weight, latestBodyWeight.unit, 'lbs')
      : null;

  const props: WorkoutLoggerProps = {
    program,
    cycleNum,
    workoutNum,
    date: workout.date,
    lifts,
    hasBodyweightComponent,
    isReadOnly,
    initialBodyWeight,
    unit,
  };

  return <WorkoutLogger {...props} />;
}
