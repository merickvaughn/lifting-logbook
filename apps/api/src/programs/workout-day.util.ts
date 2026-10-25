import { BadRequestException } from '@nestjs/common';
import {
  AppliedLiftOverrides,
  LiftingProgramSpec,
  LiftOverride,
  MacrocycleDashboard,
  applyLiftOverrides,
  programLengthWeeks,
  specRowsForWorkoutDay,
} from '@lifting-logbook/core';
import { ProgramNotFoundError } from '../ports/errors';
import { IMacrocycleDashboardRepository } from '../ports/IMacrocycleDashboardRepository';
import { ScheduledWorkout } from '../ports/IMacrocycleScheduledWorkoutRepository';
import { workoutKeyForWorkoutNum } from './mappers';

/**
 * The program's current macrocycle dashboard, or `{ macrocycleNum: 1 }` before one exists,
 * which is the macrocycle a program's workout routes address until it is initialized.
 */
export async function currentMacrocycleOrFirst(
  dashboards: IMacrocycleDashboardRepository,
  program: string,
): Promise<MacrocycleDashboard | { macrocycleNum: 1 }> {
  // fallback-covered-by: apps/api/src/programs/workouts.controller.spec.ts
  return dashboards.getMacrocycleDashboard(program).catch((err: unknown) => {
    if (err instanceof ProgramNotFoundError) return { macrocycleNum: 1 as const };
    throw err;
  });
}

export interface WorkoutDay extends AppliedLiftOverrides {
  /** The workout's program day, or undefined for a scheduled workout past the program's end. */
  workoutKey: ReturnType<typeof workoutKeyForWorkoutNum>;
  week: number;
  /** The spec rows of the workout's own program day. */
  dayRows: LiftingProgramSpec[];
}

/**
 * Resolves a workout to its program day and planned lifts — the derivation the workout
 * page and a workout's focus plan must share, so focus overlap is judged against the lifts
 * the page lists.
 *
 * The workout's day is its (week, offset) key: `workoutKeyForWorkoutNum` tiles the stored
 * block to the program's canonical length and indexes the global workoutNum into the
 * ordered workout days (#680, #740). A schedule only dates the days, so a scheduled row
 * never gives a workout its week (#1023), except for a row past the program's last day,
 * whose own week is the only one it has: it has no day, and so plans no lifts. Anything
 * else past the program's canonical length is a 400.
 *
 * Planned lifts are the day's spec lifts (#1014), each listed once even when the day
 * repeats one (#1027), after the workout's lift overrides.
 */
export function resolveWorkoutDay(
  program: string,
  workoutNum: number,
  spec: LiftingProgramSpec[],
  scheduledWorkouts: readonly ScheduledWorkout[],
  liftOverrides: readonly LiftOverride[],
): WorkoutDay {
  const workoutKey = workoutKeyForWorkoutNum(spec, workoutNum, program);
  const week = workoutKey?.week ?? scheduledWorkouts.find((s) => s.workoutNum === workoutNum)?.weekNum;
  if (week === undefined) {
    throw new BadRequestException(
      `workoutNum ${workoutNum} exceeds the program's ${programLengthWeeks(program, spec)}-week schedule`,
    );
  }
  const dayRows = workoutKey ? specRowsForWorkoutDay(spec, workoutKey.week, workoutKey.offset) : [];
  const specLifts = [...new Set(dayRows.map((s) => s.lift))];
  return { workoutKey, week, dayRows, ...applyLiftOverrides(specLifts, liftOverrides) };
}
