import 'server-only';

import {
  currentMaxLookup,
  isSameLift,
  lookupByLift,
  lookupLift,
  resolveProgression,
  storedLiftProgression,
} from '@lifting-logbook/core';
import type {
  LiftingProgramSpecResponse,
  LiftRecordResponse,
  TrainingMaxResponse,
  WorkoutResponse,
} from '@lifting-logbook/types';
import { getUserSettings } from '@/lib/active-program';
import { fetchAllLiftMetadata, fetchCustomLifts, fetchLiftRecords } from '@/lib/api';
import type { ProgressionPlan } from '@/lib/workoutPlan';
import { effectiveDateOf } from '@/lib/workoutStatus';

const PAGE = '[WorkoutLoggingPage]';

/**
 * The lift's latest session in `records` before `workout`: another workout dated on or before it.
 * Its date and each set's reps, by set number. Only a lift's first occurrence in a workout counts,
 * as in `updateMaxes`.
 */
function lastSessionOf(
  lift: string,
  workout: { workoutNum: number; date: string },
  records: readonly LiftRecordResponse[],
): ProgressionPlan['lastSession'] {
  const day = workout.date.slice(0, 10);
  const sets = records.filter(
    (r) => r.workoutNum !== workout.workoutNum && r.date.slice(0, 10) <= day && !r.occurrence && isSameLift(r.lift, lift),
  );
  if (sets.length === 0) return undefined;
  const latest = sets.reduce((a, b) => (b.date > a.date ? b : a));
  const session = sets
    .filter((r) => r.workoutNum === latest.workoutNum)
    .sort((a, b) => a.setNum - b.setNum);
  return { date: latest.date, reps: session.map((r) => r.reps) };
}

/**
 * Each of a workout's lifts' progression plan for the logger (#1211), index-aligned with
 * `workout.lifts`. A lift's type, range and increment resolve from its spec row, then its own
 * value, the lifter's default and the catalog's (`resolveProgression`), finding its own value with
 * `lookupByLift` as `updateMaxes` does. The lifter's settings are read only when some lift's row
 * names no type, and the macrocycle's records only when some lift is on `double`, which plans from
 * its last session.
 *
 * A lift with no spec row that the workout already logged keeps its logged sets as they are, with
 * no plan, so a finished workout stays read-only.
 *
 * Each read fails on its own and says which in the console: without settings a lift resolves from
 * its row and the catalog, and without records a `double` lift plans as right after a bump.
 */
export async function loadProgressionPlans(
  program: string,
  workout: Pick<WorkoutResponse, 'workoutNum' | 'lifts' | 'date' | 'overrideDate'>,
  liftSpecs: readonly (LiftingProgramSpecResponse | undefined)[],
  maxes: readonly Pick<TrainingMaxResponse, 'lift' | 'weight' | 'dateUpdated'>[],
): Promise<(ProgressionPlan | undefined)[]> {
  const needsSettings = workout.lifts.some((_, i) => !liftSpecs[i]?.progression);
  const settings = needsSettings
    ? await Promise.all([getUserSettings(), fetchCustomLifts(), fetchAllLiftMetadata()]).then(
        ([user, customLifts, metas]) => ({ user, customLifts, metaFor: lookupByLift(metas.map((m) => [m.lift, m] as const)) }),
        // fallback-covered-by: apps/web/app/(authed)/macrocycle/[macrocycleNum]/workout/[workoutNum]/page.test.tsx
        (err: unknown) => {
          console.error(`${PAGE} progression settings read failed, planning each lift by its row and the catalog`, err);
          return null;
        },
      )
    : null;

  const lifts = workout.lifts.map((wl, i) => {
    const spec = liftSpecs[i];
    // A custom lift named like a catalog one means the custom lift, which has no catalog default.
    const { builtIn, custom } = lookupLift(wl.lift, settings?.customLifts ?? []);
    const meta = settings?.metaFor(wl.lift);
    const { type, repsLow, repsHigh, increment } = resolveProgression(
      spec,
      meta && storedLiftProgression(meta),
      settings?.user.defaultProgression,
      custom ? undefined : builtIn,
      settings?.user.defaultWeightIncrement,
    );
    return { wl, spec, rule: { type, repsLow, repsHigh, increment } };
  });

  // fallback-covered-by: apps/web/app/(authed)/macrocycle/[macrocycleNum]/workout/[workoutNum]/page.test.tsx
  const records = lifts.some(({ rule }) => rule.type === 'double')
    ? await fetchLiftRecords(program).catch(
        (err: unknown) => {
          console.error(`${PAGE} lift records read failed, planning double lifts without their last session`, err);
          return [];
        },
      )
    : [];
  const maxFor = currentMaxLookup(maxes);
  const date = effectiveDateOf(workout);
  return lifts.map(({ wl, spec, rule }) => {
    if (!spec && !wl.planned && wl.sets.length > 0) return undefined;
    const lastSession = rule.type === 'double' ? lastSessionOf(wl.lift, { workoutNum: workout.workoutNum, date }, records) : undefined;
    const maxDate = maxFor(wl.lift)?.dateUpdated;
    return {
      rule,
      ...(maxDate !== undefined && { maxDate }),
      ...(lastSession && { lastSession }),
    };
  });
}
