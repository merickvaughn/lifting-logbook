import type { Prisma } from '@prisma/client';
import {
  PRESET_BASE_SPECS,
  WEEKDAY_MAP,
  Weekday,
  addDaysUTC,
  formatDateYYYYMMDD,
  noScheduleWorkoutDateUTC,
  programWorkoutKeys,
  specRowsForWorkoutDay,
  toUTCMidnight,
} from '@lifting-logbook/core';

/**
 * The rows `seed.ts` writes for the staging seed user, built without a database so
 * `seed-plan.spec.ts` can check them against what the app resolves (#1022).
 *
 * Everything that names a program, a lift or a workout comes from the preset spec,
 * so the seed can't drift from the names the app plans with: an earlier version seeded
 * program `'531'` (a catalog id with no spec) and lift names like `'squat'`, so the
 * seed user's dashboard planned nothing and none of its maxes matched a lift.
 */

export const SEED_USER_ID = 'seed_user_clerkid_staging_001';

/** A key of `PRESET_BASE_SPECS`, so the spec and `PROGRAM_DEFAULTS` both resolve it. */
export const PROGRAM = '5-3-1';

/** Whole macrocycles logged before the current one. */
const COMPLETED_MACROCYCLES = 2;
/** Program weeks of the current macrocycle that are already past, and logged. */
const CURRENT_WEEKS_LOGGED = 4;

/** Wendler's percentages of training max for each set, by block week. */
const SET_PERCENTAGES: Record<number, readonly number[]> = {
  1: [0.65, 0.75, 0.85],
  2: [0.7, 0.8, 0.9],
  3: [0.75, 0.85, 0.95],
};

/** Each preset lift's first training max (lbs) and its bodyweight-ratio strength goal. */
const LIFT_START: Record<string, { startMax: number; goalRatio: number }> = {
  Squat: { startMax: 225, goalRatio: 1.5 },
  'Bench Press': { startMax: 185, goalRatio: 1.25 },
  Deadlift: { startMax: 275, goalRatio: 2.0 },
  'Overhead Press': { startMax: 115, goalRatio: 0.75 },
};

export interface SeedPlan {
  userSettings: Prisma.UserSettingsCreateManyInput;
  macrocycles: Prisma.MacrocycleCreateManyInput[];
  dashboard: Prisma.MacrocycleDashboardCreateManyInput;
  trainingMaxes: Prisma.TrainingMaxCreateManyInput[];
  trainingMaxHistory: Prisma.TrainingMaxHistoryCreateManyInput[];
  liftRecords: Prisma.LiftRecordCreateManyInput[];
  strengthGoals: Prisma.StrengthGoalCreateManyInput[];
}

function roundToPlate(weight: number): number {
  return Math.round(weight / 2.5) * 2.5;
}

/**
 * The seed user's data as of `now`: `COMPLETED_MACROCYCLES` finished macrocycles, then a
 * current one started `CURRENT_WEEKS_LOGGED` weeks ago with every workout before today
 * logged. No workout schedule is set, so workouts are dated spec-relatively, as the
 * dashboard dates them. No `LiftMetadata` is written, so each lift's built-in muscle groups
 * apply (ADR-036).
 */
export function buildSeedPlan(now: Date): SeedPlan {
  const spec = PRESET_BASE_SPECS[PROGRAM];
  if (!spec) throw new Error(`No preset spec for "${PROGRAM}"`);

  // One entry per preset lift, in spec order, taking its increment from its first spec row.
  const lifts: { name: string; increment: number; startMax: number; goalRatio: number }[] = [];
  for (const row of spec) {
    if (lifts.some((lift) => lift.name === row.lift)) continue;
    const start = LIFT_START[row.lift];
    if (!start) throw new Error(`LIFT_START has no entry for the preset lift "${row.lift}"`);
    lifts.push({ name: row.lift, increment: row.increment, ...start });
  }
  // The training max a macrocycle (0-based) runs on: it rises by the lift's increment each one.
  const maxFor = (lift: (typeof lifts)[number], index: number) => lift.startMax + lift.increment * index;

  const keys = programWorkoutKeys(PROGRAM, spec);
  const macrocycleDays = Math.max(...keys.map((k) => k.week)) * 7;
  const today = toUTCMidnight(now);
  const currentStart = addDaysUTC(today, -CURRENT_WEEKS_LOGGED * 7);
  const currentNum = COMPLETED_MACROCYCLES + 1;
  const startWeekday = Object.values(Weekday).find(
    (day) => WEEKDAY_MAP[day.toLowerCase()] === currentStart.getUTCDay(),
  );
  if (!startWeekday) throw new Error(`No Weekday for UTC day index ${currentStart.getUTCDay()}`);

  const plan: SeedPlan = {
    userSettings: { userId: SEED_USER_ID, activeProgram: PROGRAM },
    macrocycles: [],
    dashboard: {
      userId: SEED_USER_ID,
      program: PROGRAM,
      macrocycleUnit: 'week',
      macrocycleNum: currentNum,
      macrocycleDate: currentStart,
      // As initializing a macrocycle names it (macrocycle-generation.service.ts).
      sheetName: `${PROGRAM}_Cycle_${currentNum}_${formatDateYYYYMMDD(currentStart)}`,
      macrocycleStartWeekday: startWeekday,
      programType: PROGRAM,
    },
    trainingMaxes: lifts.map((lift) => ({
      userId: SEED_USER_ID,
      program: PROGRAM,
      lift: lift.name,
      weight: maxFor(lift, COMPLETED_MACROCYCLES),
      dateUpdated: currentStart,
    })),
    trainingMaxHistory: [],
    liftRecords: [],
    strengthGoals: lifts.map((lift) => ({
      userId: SEED_USER_ID,
      program: PROGRAM,
      lift: lift.name,
      goalType: 'relative',
      unit: 'lbs',
      ratio: lift.goalRatio,
    })),
  };

  for (let index = 0; index <= COMPLETED_MACROCYCLES; index++) {
    const macrocycleNum = index + 1;
    const current = index === COMPLETED_MACROCYCLES;
    const start = addDaysUTC(currentStart, -(COMPLETED_MACROCYCLES - index) * macrocycleDays);

    // The max each macrocycle starts on, as tested at its start.
    for (const lift of lifts) {
      plan.trainingMaxHistory.push({
        userId: SEED_USER_ID,
        program: PROGRAM,
        lift: lift.name,
        weight: maxFor(lift, index),
        reps: 1,
        date: start,
        isPR: true,
        source: 'test',
        goalMet: false,
      });
    }

    let lastSession: Date | null = null;
    for (const [i, key] of keys.entries()) {
      const date = noScheduleWorkoutDateUTC(start, key.week, key.offset);
      if (date >= today) continue;
      lastSession = date;
      const occurrences = new Map<string, number>();
      for (const row of specRowsForWorkoutDay(spec, key.week, key.offset)) {
        const lift = lifts.find((l) => l.name === row.lift);
        const percentages = SET_PERCENTAGES[row.week];
        if (!lift || !percentages) throw new Error(`No seed data for ${row.lift} in block week ${row.week}`);
        const occurrence = occurrences.get(row.lift) ?? 0;
        occurrences.set(row.lift, occurrence + 1);
        for (let setNum = 1; setNum <= row.sets; setNum++) {
          const pct = percentages[setNum - 1];
          if (pct === undefined) throw new Error(`No percentage for set ${setNum} of ${row.lift}`);
          const amrap = row.amrap === true && setNum === row.sets;
          plan.liftRecords.push({
            userId: SEED_USER_ID,
            program: PROGRAM,
            macrocycleNum,
            workoutNum: i + 1,
            date,
            lift: row.lift,
            occurrence,
            setNum,
            weight: roundToPlate(maxFor(lift, index) * pct),
            // A few reps past the prescription on the AMRAP set, varying by workout.
            reps: amrap ? row.reps + 1 + ((macrocycleNum + i) % 4) : row.reps,
            notes: amrap ? 'AMRAP set' : '',
          });
        }
      }
    }

    plan.macrocycles.push({
      userId: SEED_USER_ID,
      program: PROGRAM,
      macrocycleNum,
      startDate: start,
      // As advancing closes a macrocycle: ended on its last session.
      endDate: current ? null : lastSession,
      status: current ? 'in-progress' : 'completed',
      origin: 'live',
    });
  }

  return plan;
}

/**
 * Deletes every row the seed user has, so each run writes the plan from scratch (#1022).
 * The user is synthetic and no Clerk token reaches it, so nothing else writes these rows.
 * `seed-plan.spec.ts` fails if a table with a `userId` column is missing here.
 */
export async function resetSeedUser(tx: Prisma.TransactionClient): Promise<void> {
  const where = { userId: SEED_USER_ID };
  await tx.liftRecord.deleteMany({ where });
  await tx.trainingMax.deleteMany({ where });
  await tx.missingMaxDismissal.deleteMany({ where });
  await tx.importSuggestionUsage.deleteMany({ where });
  await tx.macrocycleDashboard.deleteMany({ where });
  await tx.trainingMaxHistory.deleteMany({ where });
  await tx.bodyWeight.deleteMany({ where });
  await tx.strengthGoal.deleteMany({ where });
  await tx.workoutDateOverride.deleteMany({ where });
  await tx.workoutSkipOverride.deleteMany({ where });
  await tx.workoutLiftOverride.deleteMany({ where });
  await tx.liftMetadata.deleteMany({ where });
  await tx.customLift.deleteMany({ where });
  await tx.liftModificationMax.deleteMany({ where });
  await tx.liftModification.deleteMany({ where });
  await tx.userSettings.deleteMany({ where });
  await tx.focusBlock.deleteMany({ where });
  await tx.focusDayState.deleteMany({ where });
  await tx.macrocycleScheduledWorkout.deleteMany({ where });
  await tx.macrocycle.deleteMany({ where });
  await tx.customProgram.deleteMany({ where });
  await tx.importBatch.deleteMany({ where });
}
