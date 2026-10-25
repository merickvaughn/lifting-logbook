import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import {
  blockRange,
  blockStatus,
  defaultFocusPool,
  expandRollovers,
  parseIsoDate,
} from '@lifting-logbook/core';
import { DEFAULT_WEIGHT_INCREMENT, FocusBlock, FocusBlockResponse } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import { IFocusRepository } from '../ports/IFocusRepository';
import { isValidWorkoutNum } from '../programs/mappers';
import { currentMacrocycleOrFirst, resolveWorkoutDay } from '../programs/workout-day.util';

/** Matches `CreateLiftRecordDto.workoutNum`'s bound, and keeps the value inside INT4. */
const MAX_WORKOUT_NUM = 1000;

/**
 * Validates the `today` query parameter: the user's calendar day as an ISO date. The server
 * cannot know the user's time zone, so every endpoint whose answer depends on the day takes
 * it from the client (the core focus date math runs on UTC midnights).
 */
export function parseToday(value: string | undefined): string {
  return parseIsoDateParam('today', value);
}

/** An ISO date (`YYYY-MM-DD`) that exists in its month, or a 400. */
export function parseIsoDateParam(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new BadRequestException(`${name} is required (YYYY-MM-DD)`);
  }
  try {
    parseIsoDate(value);
  } catch {
    throw new BadRequestException(`${name} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

export function parseWorkoutNum(value: string): number {
  const workoutNum = Number(value);
  if (!/^\d+$/.test(value) || !isValidWorkoutNum(workoutNum) || workoutNum > MAX_WORKOUT_NUM) {
    throw new BadRequestException(`workoutNum must be an integer from 1 to ${MAX_WORKOUT_NUM}`);
  }
  return workoutNum;
}

export function toFocusBlockResponse(block: FocusBlock, today: string): FocusBlockResponse {
  const range = blockRange(block);
  return { ...block, status: blockStatus(block, today), rangeStart: range.start, rangeEnd: range.end };
}

/**
 * The user's focus blocks, after creating any auto-roll successor now due. Successors are
 * materialized on read rather than by a scheduled job: status is derived from dates, so a
 * block that ended while nobody loaded the app still owes its successor (ADR-039).
 *
 * Creation is idempotent on (series, start), so concurrent reads store each successor once;
 * the list is re-read afterwards so every caller sees the ids that were actually stored.
 */
export async function loadFocusBlocks(focus: IFocusRepository, today: string): Promise<FocusBlock[]> {
  const blocks = await focus.listBlocks();
  const successors = expandRollovers(blocks, today, defaultFocusPool);
  if (successors.length === 0) return blocks;
  // expandRollovers gives placeholder ids; real ones are assigned here.
  await focus.createBlocksIfAbsent(successors.map((block) => ({ ...block, id: randomUUID() })));
  return focus.listBlocks();
}

export interface FocusWorkoutContext {
  macrocycleNum: number;
  /** The day's planned lifts after overrides, by name. */
  plannedLifts: string[];
  /** The plate increment a percent-of-training-max focus weight rounds to. */
  increment: number;
}

/**
 * What a workout's focus plan needs from the program: the macrocycle, the day's planned
 * lifts and the plate increment. The planned lifts come from `resolveWorkoutDay`, the same
 * derivation `WorkoutsController.getWorkout` lists, so focus overlap is judged against the
 * lifts the workout page shows.
 */
export async function loadFocusWorkoutContext(
  repos: RepositoryBundle,
  program: string,
  workoutNum: number,
): Promise<FocusWorkoutContext> {
  const { macrocycleNum } = await currentMacrocycleOrFirst(repos.macrocycleDashboard, program);
  const [spec, liftOverrides, scheduledWorkouts, settings, customLifts] = await Promise.all([
    repos.liftingProgramSpec.getProgramSpec(program),
    repos.workoutLiftOverride.getOverrides(program, macrocycleNum, workoutNum),
    repos.macrocycleScheduledWorkout.getScheduledWorkouts(program, macrocycleNum),
    repos.userSettings.getSettings(),
    repos.customLift.list(),
  ]);
  const { dayRows, planned } = resolveWorkoutDay(program, workoutNum, spec, scheduledWorkouts, liftOverrides);

  // A lift can be stored by a custom lift's uuid; focus pools and rules name lifts.
  const nameById = new Map(customLifts.map((lift) => [lift.id, lift.name] as const));
  const plannedLifts = [...new Set(planned.map(({ lift }) => nameById.get(lift) ?? lift))];

  // The program's own increment, as for its planned lifts; the user's default when the
  // day has none.
  const increment = dayRows[0]?.increment ?? settings.defaultWeightIncrement ?? DEFAULT_WEIGHT_INCREMENT;
  return { macrocycleNum, plannedLifts, increment };
}
