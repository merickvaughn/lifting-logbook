import { notFound, redirect } from 'next/navigation';
import {
  complexIdOf,
  convertWeight,
  currentMaxLookup,
  lookupLift,
  withOccurrence,
} from '@lifting-logbook/core';
import type { CustomLiftResponse, SetResponse } from '@lifting-logbook/types';
import {
  fetchCustomLifts,
  fetchLatestBodyWeight,
  fetchModificationMaxes,
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchWorkout,
} from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { loadProgressionPlans } from '@/lib/loadProgressionPlans';
import { loadComplexes, loadFocusPlan } from '@/lib/loadWorkoutPlan';
import { movedWorkoutPath } from '@/lib/macrocycleUrl';
import { getPreferredUnit } from '@/lib/preferences';
import { liftSets, liftSpecsForWorkout, planComplex, planLift } from '@/lib/workoutPlan';
import { effectiveDateOf } from '@/lib/workoutStatus';
import { hasLoggedFocusWork, withFocusLifts } from './focusLifts';
import WorkoutLogger from './WorkoutLogger';
import type { ComplexSlot, LiftData, LoggedSet, WorkingSetData, WorkoutLoggerProps } from './types';

/**
 * Hard-coded warm-up implement names for bodyweight-component exercises, by catalog id, so
 * every name a lift goes by gets one ("Dips" and "Dip", "Pull-up" and Leangains' "Weighted
 * Pull-ups").
 * Follow-on: make these configurable per exercise (see proposal open questions).
 */
const WARMUP_IMPLEMENT: Record<string, string> = {
  'chin-up': 'lat pulldown',
  'pull-up': 'lat pulldown',
  'dip': 'dips (unweighted)',
};

/**
 * The bodyweight-component lift `liftName` names, if it is one. A built-in is found by any of
 * its names: a slot name, catalog name or id, or a preset's alias such as "Weighted Pull-ups"
 * (issue #1015). A same-named custom lift's own flag wins over a non-reserved built-in name, as
 * `lookupLift` resolves it (ADR-036, #1319).
 */
function bodyweightLift(
  liftName: string,
  customLifts: readonly CustomLiftResponse[],
): { implement: string | undefined } | undefined {
  const { builtIn, custom } = lookupLift(liftName, customLifts);
  if (!(custom?.isBodyweightComponent ?? builtIn?.isBodyweightComponent)) return undefined;
  // A custom lift sharing a built-in's name keeps that built-in's warm-up implement.
  return { implement: builtIn && WARMUP_IMPLEMENT[builtIn.id] };
}

/** A workout is read-only when every working set across every lift has a logged record. */
function allSetsLogged(lifts: readonly LiftData[]): boolean {
  const total = lifts.reduce((n, l) => n + l.workingSets.length, 0);
  const logged = lifts.reduce((n, l) => n + l.workingSets.filter((s) => s.existing).length, 0);
  return total > 0 && logged === total;
}

export default async function WorkoutLoggingPage({
  params,
}: {
  params: Promise<{ macrocycleNum: string; workoutNum: string }>;
}) {
  const { macrocycleNum: macrocycleNumParam, workoutNum: workoutNumParam } = await params;
  const macrocycleNum = Number(macrocycleNumParam);
  const workoutNum = Number(workoutNumParam);

  if (!Number.isInteger(macrocycleNum) || !Number.isInteger(workoutNum) || workoutNum < 1) {
    notFound();
  }

  const program = await getActiveProgram();

  // One read of the lifter's own lifts, shared by bodyweight detection and the progression
  // plans (#1319). A failed read leaves bodyweight to the built-ins.
  const customLiftsRead = fetchCustomLifts();

  const [workout, specs, maxes, ownMaxes, latestBodyWeight, unit, focus, customLifts] = await Promise.all([
    fetchWorkout(program, workoutNum),
    fetchProgramSpec(program),
    fetchTrainingMaxes(program),
    // Modifications' own maxes, which a toggle re-plans from without a fetch (#1153). A failed
    // read plans every lift from the lift's max, and the logger says so when an own toggle is on.
    // fallback-covered-by: apps/web/app/(authed)/macrocycle/[macrocycleNum]/workout/[workoutNum]/page.test.tsx
    fetchModificationMaxes(program).then(
      (list): Record<string, number> => Object.fromEntries(list.map((m) => [m.modificationId, m.weight])),
      (err: unknown) => {
        console.error('[WorkoutLoggingPage] own max fetch failed, planning from the lifts’ maxes', err);
        return null;
      },
    ),
    fetchLatestBodyWeight(program),
    getPreferredUnit(),
    // The same focus work the details page and the timer show (#1060). A failed fetch
    // leaves the planned lifts to log.
    loadFocusPlan(program, workoutNum, 'WorkoutLoggingPage'),
    // fallback-covered-by: apps/web/app/(authed)/macrocycle/[macrocycleNum]/workout/[workoutNum]/page.test.tsx
    customLiftsRead.catch((err: unknown): CustomLiftResponse[] => {
      console.error('[WorkoutLoggingPage] custom lift read failed, reading bodyweight from built-ins only', err);
      return [];
    }),
  ]);

  if (!workout) {
    notFound();
    return null; // unreachable; notFound() throws but TypeScript can't verify without Next.js types
  }
  // The workout read is the current macrocycle's, so an old URL follows it (#1198).
  const moved = movedWorkoutPath(`/macrocycle/${macrocycleNum}/workout/${workoutNum}`, macrocycleNum, workout.macrocycleNum);
  if (moved) redirect(moved);

  const maxFor = currentMaxLookup(maxes);
  const liftSpecs = liftSpecsForWorkout(workout, specs);
  // What each lift plans by besides its row: its progression type and last session (#1211).
  // A complex slot is shown, not logged, until #1496: it stays out of `lifts`.
  const [progressions, complexList] = await Promise.all([
    loadProgressionPlans(workout, liftSpecs, maxes, 'WorkoutLoggingPage', () => customLiftsRead),
    loadComplexes(workout.lifts, 'WorkoutLoggingPage'),
  ]);
  const complexes: ComplexSlot[] = workout.lifts.flatMap((wl, liftIndex) => {
    const planned = planComplex(wl.lift, liftSpecs[liftIndex], (l) => maxFor(l)?.weight, complexList);
    if (planned === undefined) return [];
    const workWeights = planned.plannedSets.filter((s) => s.type === 'work').map((s) => s.weight);
    return [{ complex: planned.complex, tm: planned.tm, workWeights }];
  });

  const workoutLifts: LiftData[] = workout.lifts.flatMap((wl, liftIndex) => {
    if (complexIdOf(wl.lift) !== undefined) return [];
    const tm = maxFor(wl.lift)?.weight ?? 0;

    // The lift's prescription — provides warmUpPct and increment. Resolved through
    // the block week at the workout's day, and for a Manage Lifts replacement from
    // the slot it replaced; `tm` stays the replacement's own (issue #1014).
    const spec = liftSpecs[liftIndex];

    // The plan comes from the spec, the same as on the details page: the API sends
    // an unlogged planned lift with no sets, and a partly logged lift with only the
    // sets logged so far (#1080). An `own` toggle re-plans it in the logger (#1153).
    // Its progression type shapes it here too: a `double` lift plans its range, and a lift
    // with no row on `linear` or `amrap_gated` plans its `repsHigh` (#1211).
    const progression = progressions[liftIndex];
    const { warmUpSets, workSets } = liftSets(planLift(spec, tm, { progression }));

    // `planned: false` is the API's contract for "these sets are logged records".
    // Each brings its own record id and notes (issue #978), so the page no longer
    // fetches the whole macrocycle's lift records just to look them up — which also
    // fixes a `replace`-override edge: the old name-based `.find` missed a
    // renamed lift's records, showing its logged sets as unlogged.
    const logged = new Map((wl.planned ? [] : wl.sets).map((s) => [s.setNum, s]));
    const toExisting = (s: SetResponse): LoggedSet => ({
      id: s.id,
      weight: s.weight,
      reps: s.reps,
      notes: s.notes,
      ...(s.modifications && { modifications: s.modifications }),
    });

    const workingSets: WorkingSetData[] = workSets.map((p, i) => {
      const { setNum } = p;
      const record = logged.get(setNum);
      logged.delete(setNum);
      return {
        setNum,
        totalLoad: p.totalLoad,
        reps: p.reps,
        // The spec's AMRAP flag marks the lift's last working set.
        amrap: Boolean(spec?.amrap) && i === workSets.length - 1,
        ...(record && { existing: toExisting(record) }),
      };
    });
    // A logged set the plan has no slot for (an extra set, or a lift with no
    // prescription) still shows, as logged.
    for (const s of [...logged.values()].sort((a, b) => a.setNum - b.setNum)) {
      workingSets.push({ setNum: s.setNum, totalLoad: s.weight, reps: s.reps, amrap: s.amrap, existing: toExisting(s) });
    }

    const bodyweight = bodyweightLift(wl.lift, customLifts);

    return {
      lift: wl.lift,
      // Each occurrence of a lift the day plans twice logs its own sets (#1027).
      ...withOccurrence(wl.occurrence),
      isBodyweightComponent: bodyweight !== undefined,
      warmUpImplement: bodyweight?.implement,
      warmUpSets,
      workingSets,
      ...(spec && { plan: { spec, liftMax: tm, ...(progression && { progression }) } }),
      ...(progression && { progressionRule: { type: progression.rule.type, increment: progression.rule.increment } }),
    };
  });

  // The focus plan is today's, so it joins the workouts the details page offers it on (not
  // logged yet, not skipped), the workout being logged today, and one whose focus work is
  // already under way. An older workout, logged on its own day, stays as it was: today's
  // focus lifts logged against its date would fall outside the focus block's range.
  const anyLogged = workoutLifts.some((l) => l.workingSets.some((s) => s.existing));
  const offerFocus =
    focus.plan !== null &&
    !workout.skipped &&
    (!anyLogged ||
      effectiveDateOf(workout) === focus.plan.today ||
      hasLoggedFocusWork(workoutLifts, focus.plan));
  const lifts = offerFocus && focus.plan ? withFocusLifts(workoutLifts, focus.plan, unit) : workoutLifts;

  const hasBodyweightComponent = lifts.some((l) => l.isBodyweightComponent);

  const isReadOnly = allSetsLogged(lifts);

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
    macrocycleNum,
    ...(workout.macrocycleId !== undefined && { macrocycleId: workout.macrocycleId }),
    workoutNum,
    date: workout.date,
    lifts,
    hasBodyweightComponent,
    isReadOnly,
    initialBodyWeight,
    unit,
    ownMaxes,
    ...(complexes.length > 0 && { complexes }),
  };

  return <WorkoutLogger {...props} />;
}
