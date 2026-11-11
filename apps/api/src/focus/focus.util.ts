import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import {
  blockRange,
  blockStatus,
  defaultFocusPool,
  expandRollovers,
  nextStart,
  parseIsoDate,
} from '@lifting-logbook/core';
import { DEFAULT_WEIGHT_INCREMENT, FocusBlock, FocusBlockResponse } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import { FocusBlockPatch, IFocusRepository } from '../ports/IFocusRepository';
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
 *
 * A `percent_wave` successor's maxes go up by the user's default weight increment: the
 * successor is created outside any workout, so there is no program increment to use
 * (ADR-039, Amendment 2). Settings are read only when such a successor is due, which is
 * once per block, not on every read.
 */
export async function loadFocusBlocks(
  repos: Pick<RepositoryBundle, 'focus' | 'userSettings'>,
  today: string,
): Promise<FocusBlock[]> {
  const { focus } = repos;
  const blocks = await focus.listBlocks();
  let successors = expandRollovers(blocks, today, defaultFocusPool, 0);
  if (successors.length === 0) return blocks;
  if (successors.some((successor) => successor.progression === 'percent_wave')) {
    const settings = await repos.userSettings.getSettings();
    const increment = settings.defaultWeightIncrement ?? DEFAULT_WEIGHT_INCREMENT;
    successors = expandRollovers(blocks, today, defaultFocusPool, increment);
  }
  // expandRollovers gives placeholder ids; real ones are assigned here.
  await focus.createBlocksIfAbsent(successors.map((block) => ({ ...block, id: randomUUID() })));
  return focus.listBlocks();
}

const TIMER_FIELDS = ['prep', 'set', 'rest'] as const;

/**
 * Carries an edit to a block into its successor while the successor is still queued. A
 * successor is stored on the first read after its block starts, with a copy of the block
 * as it was then, so without this an edit made mid-block would never reach it.
 *
 * Selection, overlap, progression and each timer value follow when the successor still
 * holds the block's value from before the edit; one the lifter changed on the successor
 * stays. Under `percent_wave`, each shared lift's max moves by the same amount the block's
 * did, which keeps an edit already made to the successor's max (ADR-039, Amendments 2-3).
 */
export async function carryEditsToSuccessor(
  focus: IFocusRepository,
  before: FocusBlock,
  after: FocusBlock,
  today: string,
): Promise<void> {
  const start = nextStart(before);
  const successor = (await focus.listBlocks()).find(
    (block) =>
      block.id !== after.id && block.series === after.series && block.start === start && blockStatus(block, today) === 'queued',
  );
  if (!successor) return;

  const patch: FocusBlockPatch = {};
  const follows = (field: 'selection' | 'overlap' | 'progression') =>
    before[field] !== after[field] && successor[field] === before[field];
  if (follows('selection')) patch.selection = after.selection;
  if (follows('overlap')) patch.overlap = after.overlap;
  if (follows('progression')) patch.progression = after.progression;

  const timer = { ...successor.timer };
  for (const key of TIMER_FIELDS) {
    if (before.timer[key] !== after.timer[key] && successor.timer[key] === before.timer[key]) timer[key] = after.timer[key];
  }
  if (TIMER_FIELDS.some((key) => timer[key] !== successor.timer[key])) patch.timer = timer;

  if (after.progression === 'percent_wave') {
    const changes = trainingMaxChanges(before, after);
    if (changes.size > 0) {
      patch.pool = successor.pool.map((entry) => {
        const change = changes.get(entry.lift);
        return change === undefined ? entry : { ...entry, trainingMax: entry.trainingMax + change };
      });
    }
  }

  if (Object.keys(patch).length > 0) await focus.updateBlock(successor.id, patch);
}

/** How far each lift's training max moved in the edit, for the lifts whose max did. */
function trainingMaxChanges(before: FocusBlock, after: FocusBlock): Map<string, number> {
  const changes = new Map<string, number>();
  for (const entry of after.pool) {
    const prior = before.pool.find((old) => old.lift === entry.lift);
    if (prior && prior.trainingMax !== entry.trainingMax) changes.set(entry.lift, entry.trainingMax - prior.trainingMax);
  }
  return changes;
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
  const { macrocycleNum } = await currentMacrocycleOrFirst(repos, program);
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
