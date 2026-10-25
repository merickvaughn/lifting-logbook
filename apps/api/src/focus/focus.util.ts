import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import {
  applyLiftOverrides,
  blockRange,
  blockStatus,
  defaultFocusPool,
  expandRollovers,
  parseIsoDate,
  programLengthWeeks,
  specRowsForWorkoutDay,
} from '@lifting-logbook/core';
import { DEFAULT_WEIGHT_INCREMENT, FocusBlock, FocusBlockResponse } from '@lifting-logbook/types';
import { ProgramNotFoundError } from '../ports/errors';
import { RepositoryBundle } from '../ports/factory';
import { IFocusRepository } from '../ports/IFocusRepository';
import { isValidWorkoutNum, workoutKeyForWorkoutNum } from '../programs/mappers';

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
  if (!/^\d+$/.test(value) || !isValidWorkoutNum(workoutNum)) {
    throw new BadRequestException('workoutNum must be a positive integer');
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

/** The macrocycle a program's workout routes address: its current one, or 1 before any. */
export async function currentMacrocycleNum(repos: RepositoryBundle, program: string): Promise<number> {
  // fallback-covered-by: apps/api/src/focus/focus.e2e.spec.ts
  const dashboard = await repos.macrocycleDashboard.getMacrocycleDashboard(program).catch((err: unknown) => {
    if (err instanceof ProgramNotFoundError) return { macrocycleNum: 1 };
    throw err;
  });
  return dashboard.macrocycleNum;
}

export interface FocusWorkoutContext {
  macrocycleNum: number;
  /** The day's planned lifts after overrides, by name. */
  plannedLifts: string[];
  /** The plate increment a percent-of-training-max focus weight rounds to. */
  increment: number;
}

/**
 * What a workout's focus plan needs from the program: the day's planned lifts and the
 * plate increment. The planned lifts follow WorkoutsController.getWorkout — the workout's
 * own program day (`workoutKeyForWorkoutNum` → `specRowsForWorkoutDay`), deduped, then
 * `applyLiftOverrides` — so focus overlap is judged against the lifts the workout page lists.
 */
export async function loadFocusWorkoutContext(
  repos: RepositoryBundle,
  program: string,
  workoutNum: number,
): Promise<FocusWorkoutContext> {
  const macrocycleNum = await currentMacrocycleNum(repos, program);
  const [spec, liftOverrides, settings, customLifts] = await Promise.all([
    repos.liftingProgramSpec.getProgramSpec(program),
    repos.workoutLiftOverride.getOverrides(program, macrocycleNum, workoutNum),
    repos.userSettings.getSettings(),
    repos.customLift.list(),
  ]);

  const workoutKey = workoutKeyForWorkoutNum(spec, workoutNum, program);
  if (!workoutKey) {
    // As in getWorkout: a scheduled row past the program's last day is a real workout
    // with no program day, so it plans no lifts; anything else is out of range.
    const scheduled = await repos.macrocycleScheduledWorkout.getScheduledWorkouts(program, macrocycleNum);
    if (!scheduled.some((s) => s.workoutNum === workoutNum)) {
      throw new BadRequestException(
        `workoutNum ${workoutNum} exceeds the program's ${programLengthWeeks(program, spec)}-week schedule`,
      );
    }
  }
  const dayRows = workoutKey ? specRowsForWorkoutDay(spec, workoutKey.week, workoutKey.offset) : [];
  const { planned } = applyLiftOverrides([...new Set(dayRows.map((row) => row.lift))], liftOverrides);

  // A lift can be stored by a custom lift's uuid; focus pools and rules name lifts.
  const nameById = new Map(customLifts.map((lift) => [lift.id, lift.name] as const));
  const plannedLifts = [...new Set(planned.map(({ lift }) => nameById.get(lift) ?? lift))];

  // The program's own increment, as for its planned lifts; the user's default when the
  // day has none.
  const increment = dayRows[0]?.increment ?? settings.defaultWeightIncrement ?? DEFAULT_WEIGHT_INCREMENT;
  return { macrocycleNum, plannedLifts, increment };
}
