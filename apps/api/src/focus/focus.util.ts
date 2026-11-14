import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import {
  blockRange,
  blockStatus,
  defaultFocusPool,
  expandRollovers,
  nextStart,
  parseIsoDate,
  recordLastSessions,
  withoutStaleLastReps,
} from '@lifting-logbook/core';
import { DEFAULT_WEIGHT_INCREMENT, FocusBlock, FocusBlockResponse } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import { FocusBlockConflictError, FocusBlockNotFoundError } from '../ports/errors';
import { FocusBlockPatch, IFocusRepository } from '../ports/IFocusRepository';
import { MAX_WORKOUT_NUM } from '../programs/lift-record.limits';
import { isValidWorkoutNum } from '../programs/mappers';
import { currentMacrocycleOrFirst, resolveWorkoutDay } from '../programs/workout-day.util';

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
 * Saves an edit to a block, and carries it into the block's successor while the successor is
 * still queued. A successor is stored on the first read after its block starts, with a copy of
 * the block as it was then, so without this an edit made mid-block would never reach it.
 *
 * The block is read under its row lock, so a pool written from it on a workout's plan read
 * can't land between this read and the update, which `withoutStaleLastReps` and the carry both
 * compare against (ADR-039, Amendment 5). A date edit moves the block's queued follow-on to
 * start the day after its new range. It is refused with `FocusBlockConflictError` before
 * anything is written when the block's new start or the follow-on's is another series block's
 * start, or when either new range would overlap a queued block in the series that the old one
 * didn't (Amendment 6).
 */
export async function saveBlockEdit(
  focus: IFocusRepository,
  id: string,
  patch: FocusBlockPatch,
  today: string,
): Promise<FocusBlock> {
  const [before] = await focus.lockBlocks([id]);
  if (!before) throw new FocusBlockNotFoundError(id);
  const edit = patch.pool ? { ...patch, pool: withoutStaleLastReps(before.pool, patch.pool) } : patch;
  const after: FocusBlock = { ...before, ...edit };

  const blocks = await focus.listBlocks();
  const followOn = await lockedFollowOn(focus, blocks, before, after, today);
  // Only the successor (the block on the day after) takes the block's settings (Amendment 4);
  // a follow-on the lifter queued later, inside the block's new range, only moves.
  const carry =
    !followOn ? {}
    : followOn.start === nextStart(before) ? successorPatch(before, after, followOn)
    : startAfter(after, followOn);
  checkSeriesDates(blocks, before, after, followOn, carry, today);
  if (!followOn || Object.keys(carry).length === 0) return focus.updateBlock(id, edit);

  const carryIntoFollowOn = async () => {
    try {
      await focus.updateBlock(followOn.id, carry);
    } catch (e) {
      // The lock lasts only as long as a transaction, and a repository on the base client has
      // none: deleted since it was read (declined in another tab), there is nothing left to
      // carry into, and the block's own edit is still saved.
      if (!(e instanceof FocusBlockNotFoundError)) throw e;
    }
  };
  // Starts are unique within a series, so a follow-on moving later moves first, in case the
  // block's new start is the follow-on's old one; one moving earlier waits for the block.
  if (carry.start !== undefined && carry.start > followOn.start) {
    await carryIntoFollowOn();
    return focus.updateBlock(id, edit);
  }
  const updated = await focus.updateBlock(id, edit);
  await carryIntoFollowOn();
  return updated;
}

/**
 * The queued block that follows `before` in its series, read again under its row lock: the
 * carry is computed from its current values, so an edit to it saved in another request must
 * land first, not be overwritten (ADR-039, Amendment 5). That is the successor, starting the
 * day after `before` ends, or else the first queued block in the series that starts after
 * `before`'s old range and inside its new one, which a lengthened block would otherwise
 * overlap (Amendment 6). Gone by now (declined in another tab): there is nothing to carry into.
 */
async function lockedFollowOn(
  focus: IFocusRepository,
  blocks: readonly FocusBlock[],
  before: FocusBlock,
  after: FocusBlock,
  today: string,
): Promise<FocusBlock | undefined> {
  const successorStart = nextStart(before);
  const oldEnd = blockRange(before).end;
  const newEnd = blockRange(after).end;
  const isFollowOn = (block: FocusBlock) =>
    block.id !== before.id &&
    block.series === before.series &&
    blockStatus(block, today) === 'queued' &&
    (block.start === successorStart || (block.start > oldEnd && block.start <= newEnd));
  const listed = blocks
    .filter(isFollowOn)
    .sort((a, b) => Number(b.start === successorStart) - Number(a.start === successorStart) || a.start.localeCompare(b.start))[0];
  if (!listed) return undefined;
  const [followOn] = (await focus.lockBlocks([listed.id])).filter(isFollowOn);
  return followOn;
}

/**
 * Throws `FocusBlockConflictError` when the edit would put two blocks in the series on one
 * start, or overlap a queued block in the series that neither block overlapped before. It runs
 * before either write, against the blocks as listed; a start taken after the list was read is
 * refused by the unique constraint, and the request's transaction rolls back the other write.
 */
function checkSeriesDates(
  blocks: readonly FocusBlock[],
  before: FocusBlock,
  after: FocusBlock,
  followOn: FocusBlock | undefined,
  carry: FocusBlockPatch,
  today: string,
): void {
  const others = blocks.filter((b) => b.series === before.series && b.id !== before.id && b.id !== followOn?.id);
  // A follow-on that moves frees its start; one that stays keeps it.
  const staying = followOn && carry.start === undefined ? [followOn] : [];
  for (const start of [after.start === before.start ? undefined : after.start, carry.start]) {
    const taken = start !== undefined && [...others, ...staying].some((b) => b.start === start);
    if (taken) throw new FocusBlockConflictError(before.series, start);
  }
  const moves: [FocusBlock, FocusBlock][] = [[before, after]];
  if (followOn && carry.start !== undefined) moves.push([followOn, { ...followOn, ...carry }]);
  for (const [was, now] of moves) {
    const clash = others.find((b) => blockStatus(b, today) === 'queued' && overlaps(now, b) && !overlaps(was, b));
    if (clash) throw new FocusBlockConflictError(before.series, clash.start);
  }
}

function overlaps(a: FocusBlock, b: FocusBlock): boolean {
  const x = blockRange(a);
  const y = blockRange(b);
  return x.start <= y.end && y.start <= x.end;
}

/** Moves `followOn` to start the day after `after` ends, if it doesn't already. */
function startAfter(after: FocusBlock, followOn: FocusBlock): FocusBlockPatch {
  const start = nextStart(after);
  return start === followOn.start ? {} : { start };
}

/**
 * What a queued successor takes from its block's edit. Selection, overlap, progression,
 * period, align and each timer value follow when the successor still holds the block's value
 * from before the edit; one the lifter changed on the successor stays. Under `percent_wave`,
 * each shared lift's max moves by the same amount the block's did, which keeps an edit already
 * made to the successor's max (ADR-039, Amendments 2 and 4). The successor moves to start the
 * day after the block's new range ends, so the series has no overlap and no gap (Amendment 6).
 */
function successorPatch(before: FocusBlock, after: FocusBlock, successor: FocusBlock): FocusBlockPatch {
  const patch: FocusBlockPatch = {};
  const follows = (field: 'selection' | 'overlap' | 'progression' | 'period' | 'align') =>
    before[field] !== after[field] && successor[field] === before[field];
  if (follows('selection')) patch.selection = after.selection;
  if (follows('overlap')) patch.overlap = after.overlap;
  if (follows('progression')) patch.progression = after.progression;
  if (follows('period')) patch.period = after.period;
  if (follows('align')) patch.align = after.align;
  Object.assign(patch, startAfter(after, successor));

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
  return patch;
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

/**
 * Records each active `double` block's last session per pool lift (`recordLastSessions`)
 * and stores the blocks that changed, so their prescriptions progress from what was
 * logged (#1221). Written on the focus plan read, like a successor, rather than on each
 * lift-record write: a record doesn't say which block it was for, and a set logged
 * mid-session must not move that session's own plan (ADR-039, Amendment 3).
 *
 * Returns `blocks` with the stored changes applied.
 */
export async function recordFocusSessions(
  repos: Pick<RepositoryBundle, 'focus' | 'liftRecord' | 'customLift'>,
  blocks: FocusBlock[],
  today: string,
): Promise<FocusBlock[]> {
  const doubles = blocks.filter((block) => block.progression === 'double' && blockStatus(block, today) === 'active');
  if (doubles.length === 0) return blocks;

  // Records can store a custom lift by its uuid; recordLastSessions matches by name.
  const poolLifts = new Set(doubles.flatMap((block) => block.pool.map((entry) => entry.lift)));
  const customs = (await repos.customLift.list()).filter((lift) => poolLifts.has(lift.name));
  const nameById = new Map(customs.map((lift) => [lift.id, lift.name] as const));
  // Nothing before the earliest block's start can be recorded, so it isn't read.
  const from = doubles.map((block) => blockRange(block).start).reduce((a, b) => (a < b ? a : b));
  const records = (
    await repos.liftRecord.getRecordsForLifts([...poolLifts, ...nameById.keys()], parseIsoDate(today), parseIsoDate(from))
  ).map((record) => ({ ...record, lift: nameById.get(record.lift) ?? record.lift }));

  // Only blocks with a session to record are written, and only those are locked, so a plan
  // read with nothing new doesn't wait on other requests.
  const due = doubles.filter((block) => recordLastSessions(block, records, today) !== null);
  if (due.length === 0) return blocks;

  // The pool written is computed from the block's current pool, so it's read again under the
  // row lock: a setup edit saved since `blocks` was read lands first and is kept (ADR-039,
  // Amendment 5). A lift that edit added has no records read here, and is recorded on the
  // next plan read. Each block read again replaces its older copy in what's returned.
  const current = new Map<string, FocusBlock>();
  for (const block of await repos.focus.lockBlocks(due.map((block) => block.id))) {
    const pool =
      block.progression === 'double' && blockStatus(block, today) === 'active'
        ? recordLastSessions(block, records, today)
        : null;
    current.set(block.id, pool ? await repos.focus.updateBlock(block.id, { pool }) : block);
  }
  return blocks.map((block) => current.get(block.id) ?? block);
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
