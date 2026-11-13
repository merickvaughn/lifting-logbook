import 'server-only';

import {
  currentMaxLookup,
  isSameLift,
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
import { fetchCustomLifts, fetchLiftMetadata, fetchLiftRecords, fetchUserSettings } from '@/lib/api';
import type { ProgressionPlan } from '@/lib/workoutPlan';
import { effectiveDateOf } from '@/lib/workoutStatus';

/**
 * The lift's latest session in `records` before `workout`: another workout dated on or before it.
 * Its date and each set's reps, by set number. Only a lift's first occurrence in a workout counts,
 * as in `updateMaxes`.
 */
export function lastSessionOf(
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
 * value, the lifter's default and the catalog's (`resolveProgression`). The lifter's settings
 * are read only when some lift's row names no type, and the macrocycle's records only when some
 * lift is on `double`, which plans from its last session.
 *
 * A failed read plans every lift by its row, as before #1211, and says so in the console.
 */
export async function loadProgressionPlans(
  program: string,
  workout: Pick<WorkoutResponse, 'workoutNum' | 'lifts' | 'date' | 'overrideDate'>,
  liftSpecs: readonly (LiftingProgramSpecResponse | undefined)[],
  maxes: readonly Pick<TrainingMaxResponse, 'lift' | 'weight' | 'dateUpdated'>[],
): Promise<(ProgressionPlan | undefined)[]> {
  try {
    const unnamed = workout.lifts.filter((_, i) => !liftSpecs[i]?.progression).map((wl) => wl.lift);
    const lifts = [...new Set(unnamed)];
    const [settings, customLifts, metas] =
      lifts.length > 0
        ? await Promise.all([fetchUserSettings(), fetchCustomLifts(), Promise.all(lifts.map((l) => fetchLiftMetadata(l)))])
        : [null, [], []];
    const metaFor = new Map(lifts.map((l, i) => [l, metas[i]]));

    const resolved = workout.lifts.map((wl, i) => {
      const meta = metaFor.get(wl.lift);
      // A custom lift named like a catalog one means the custom lift, which has no catalog default.
      const { builtIn, custom } = lookupLift(wl.lift, customLifts);
      const progression = resolveProgression(
        liftSpecs[i],
        meta && storedLiftProgression(meta),
        settings?.defaultProgression,
        custom ? undefined : builtIn,
        settings?.defaultWeightIncrement,
      );
      return { lift: wl.lift, progression };
    });

    const records = resolved.some((r) => r.progression.type === 'double') ? await fetchLiftRecords(program) : [];
    const maxFor = currentMaxLookup(maxes);
    return resolved.map(({ lift, progression }) => {
      const lastSession = lastSessionOf(lift, { workoutNum: workout.workoutNum, date: effectiveDateOf(workout) }, records);
      const maxDate = maxFor(lift)?.dateUpdated;
      return {
        progression,
        ...(maxDate !== undefined && { maxDate }),
        ...(lastSession && { lastSession }),
      };
    });
  } catch (err) {
    console.error('[WorkoutLoggingPage] progression read failed, planning every lift by its spec row', err);
    return workout.lifts.map(() => undefined);
  }
}
