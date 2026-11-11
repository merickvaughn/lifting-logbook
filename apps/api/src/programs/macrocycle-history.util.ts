import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ImportPreImage, MacrocycleDashboard, MAX_FILE_MACROCYCLE_NUM, toUTCMidnight } from '@lifting-logbook/core';
import { MacrocycleStatus } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import { KeyNumbers, preImageKeyNumber } from '../ports/IImportBatchRepository';
import { DateRange, dateRangesByMacrocycle } from '../ports/ILiftRecordRepository';
import { MacrocycleRow, NewMacrocycle } from '../ports/IMacrocycleRepository';
import { MacrocycleNumberConflictError, ProgramNotFoundError } from '../ports/errors';

/**
 * Macrocycle history (ADR-042): one `macrocycle` row per macrocycle, numbers allocated from
 * what's stored, and the write guard that keeps imported history read-only.
 */

type HistoryRepos = Pick<RepositoryBundle, 'macrocycle' | 'macrocycleDashboard'>;

const tracer = trace.getTracer('macrocycle-history');

/** A break longer than this ends a run (proposal decision 4); an older `in-progress` reads as `abandoned`. */
export const STALE_AFTER_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function dashboardOrNull(
  repos: Pick<RepositoryBundle, 'macrocycleDashboard'>,
  program: string,
): Promise<MacrocycleDashboard | null> {
  // fallback-covered-by: apps/api/src/programs/macrocycle-history.e2e.spec.ts
  return repos.macrocycleDashboard.getMacrocycleDashboard(program).catch((err: unknown) => {
    if (err instanceof ProgramNotFoundError) return null;
    throw err;
  });
}

/**
 * The number the program's next new macrocycle takes: one past every number stored, so it
 * can't land on an imported or legacy one. The current macrocycle (`dashboard`, already loaded
 * by the caller) counts too, for one the previous API revision started without a row.
 */
export async function nextMacrocycleNumber(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  program: string,
  dashboard: Pick<MacrocycleDashboard, 'macrocycleNum'> | null,
): Promise<number> {
  return Math.max(await repos.macrocycle.highestNumber(program), dashboard?.macrocycleNum ?? 0) + 1;
}

/** The row the current macrocycle gets when it has none. */
function currentRow(dashboard: MacrocycleDashboard): NewMacrocycle {
  return {
    program: dashboard.program,
    macrocycleNum: dashboard.macrocycleNum,
    startDate: toUTCMidnight(dashboard.macrocycleDate),
    status: 'in-progress',
    origin: 'live',
  };
}

/**
 * The current macrocycle's row, created as `live` if it has none: the previous API revision
 * started macrocycles without one (see the migration's deploy note). A concurrent request
 * creating it too is no conflict, and makes the same row from the same dashboard.
 */
export async function ensureCurrentRow(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  dashboard: MacrocycleDashboard,
): Promise<Pick<MacrocycleRow, 'startDate' | 'status' | 'statusChosen'>> {
  const row = await repos.macrocycle.findByNumber(dashboard.program, dashboard.macrocycleNum);
  if (row) return row;
  const created = currentRow(dashboard);
  await repos.macrocycle.ensure([created]);
  return { ...created, statusChosen: false };
}

function readOnly(program: string, macrocycleNum: number): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'macrocycle-read-only',
    message: `Macrocycle ${macrocycleNum} of '${program}' is imported history and can't be changed. Undo its import to correct it.`,
    error: 'Conflict',
  });
}

function unknownNumber(program: string, macrocycleNum: number): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: 'macrocycle-not-found',
    message: `Program '${program}' has no macrocycle ${macrocycleNum}. Reload the page to see the current one.`,
    error: 'Not Found',
    macrocycleNum,
  });
}

/**
 * The stable id of the current macrocycle (`dashboard`), for a page to send back with its
 * writes. The caller holds the shared macrocycle lock and read `dashboard` under it, so the
 * number and the id agree. The macrocycle gets its row here if the previous API revision
 * started it without one.
 */
export async function macrocycleIdFor(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  dashboard: MacrocycleDashboard,
): Promise<string | undefined> {
  const row = await repos.macrocycle.findByNumber(dashboard.program, dashboard.macrocycleNum);
  if (row) return row.id;
  await repos.macrocycle.ensure([currentRow(dashboard)]);
  // `ensure` doesn't return ids, and a concurrent request may have made the row.
  return (await repos.macrocycle.findByNumber(dashboard.program, dashboard.macrocycleNum))?.id;
}


const writeLogger = new Logger('MacrocycleWrite');

/**
 * How long an import waits for the page writes holding the macrocycle lock to finish. They're
 * short, so an import rarely waits at all; the request's transaction budget
 * (`IMPORT_TX_TIMEOUT_MS`) leaves room for it.
 */
export const IMPORT_LOCK_WAIT_MS = 5_000;

function importInProgress(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'import-in-progress',
    message: 'An import is changing your macrocycles. Try again in a moment.',
    error: 'Conflict',
  });
}

/**
 * An import's, or a renumbering's, lock wait ran out. Written for the person importing, starting or
 * deleting, who caused neither.
 */
function writesInProgress(action?: 'import' | 'undo'): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'macrocycle-busy',
    message: `Your workouts are being saved. Try ${action ? `the ${action} ` : ''}again in a moment.`,
    error: 'Conflict',
  });
}

/** The page's id names no macrocycle, as when the one it showed was deleted and started again. */
function unknownId(program: string, macrocycleId: string): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: 'macrocycle-not-found',
    message: `This page's macrocycle of '${program}' no longer exists. Reload the page to see the current one.`,
    error: 'Not Found',
    macrocycleId,
  });
}

/**
 * A route with no number got the id of a macrocycle that's no longer the current one.
 * `currentNum` is the current macrocycle's number, which the body carries.
 */
function notCurrent(program: string, currentNum: number): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'macrocycle-not-current',
    message: `This page is for an earlier macrocycle of '${program}'. Macrocycle ${currentNum} is the current one. Reload the page to see it.`,
    error: 'Conflict',
    macrocycleNum: currentNum,
  });
}

function moved(program: string, macrocycleNum: number): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'macrocycle-moved',
    message: `This macrocycle of '${program}' is now number ${macrocycleNum}. Reload the page.`,
    error: 'Conflict',
    macrocycleNum,
  });
}

/**
 * Takes the user's macrocycle lock in shared mode for the rest of the request's transaction, so
 * an import's renumbering can't commit between a write's checks and the write itself. Every
 * write to a macrocycle takes it, page writes and macrocycle starts and deletes alike. An import
 * holding it is a 409 `import-in-progress` at once: a page write doesn't wait.
 */
export async function lockForMacrocycleWrite(repos: Pick<RepositoryBundle, 'macrocycle'>): Promise<void> {
  if (!(await repos.macrocycle.tryLockShared())) throw importInProgress();
}

/**
 * Starts a write a page makes to one macrocycle (proposal decision 3). It takes the shared lock
 * ({@link lockForMacrocycleWrite}), then checks that the page's stable id still names `macrocycleNum`: a different number is a
 * 409 `macrocycle-moved` carrying the new one, and an id the user doesn't have in this program
 * is a 404. A write with no id is still accepted until #1200, and logged so the remaining ones
 * can be counted. Returns the id's row, for {@link assertMacrocycleWritable} to reuse, or null
 * when the write had no id.
 *
 * `current` is for a route with no number, which writes to the current macrocycle
 * (`macrocycleNum`): there a different number means the page is for an older macrocycle, not
 * that its macrocycle moved, so the 409 is `macrocycle-not-current`, carrying the current
 * number. `locked` says the caller already took the lock, as a route with no number must
 * before it reads the current one.
 */
export async function checkMacrocycleId(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  program: string,
  macrocycleNum: number,
  macrocycleId: string | undefined,
  route: string,
  { current = false, locked = false }: { current?: boolean; locked?: boolean } = {},
): Promise<MacrocycleRow | null> {
  if (!locked) await lockForMacrocycleWrite(repos);
  if (!macrocycleId) {
    writeLogger.log({ route, program }, 'Macrocycle write without an id (#1198)');
    return null;
  }
  const row = await repos.macrocycle.findById(macrocycleId);
  if (!row || row.program !== program) throw unknownId(program, macrocycleId);
  if (row.macrocycleNum !== macrocycleNum) {
    throw current ? notCurrent(program, macrocycleNum) : moved(program, row.macrocycleNum);
  }
  return row;
}

/**
 * Takes the user's macrocycle lock exclusively for an import, or an import's undo, that writes
 * or removes macrocycles (proposal decision 13), so no page write runs alongside it. It waits
 * up to {@link IMPORT_LOCK_WAIT_MS} for the page writes holding the lock to finish, then gives
 * a 409 `macrocycle-busy` asking the importer to try again.
 */
export async function lockForImport(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  action: 'import' | 'undo' = 'import',
): Promise<void> {
  if (!(await repos.macrocycle.lockExclusive(IMPORT_LOCK_WAIT_MS))) throw writesInProgress(action);
}

/**
 * Takes the macrocycle lock exclusively for a renumbering that would move a number (#1199),
 * waiting as an import does, then a 409 `macrocycle-busy`. The lock is re-entrant, so an import
 * that holds it already gets it at once. Two starts or deletes that hold it shared and wait on
 * each other here deadlock; Postgres aborts one, which gets the same 409 when it's the one
 * waiting here. A deadlock aborted anywhere else in the request is a 500, and that request's
 * transaction rolls back.
 */
export async function lockForRenumbering(repos: Pick<RepositoryBundle, 'macrocycle'>): Promise<void> {
  if (!(await repos.macrocycle.lockExclusive(IMPORT_LOCK_WAIT_MS))) throw writesInProgress();
}

/**
 * Guards a write scoped to one macrocycle (proposal decision 2): an `imported` macrocycle is
 * read-only (409 `macrocycle-read-only`) and a number the program doesn't have is a 404
 * (`macrocycle-not-found`). `live` and `legacy` macrocycles stay writable. The current
 * macrocycle gets its row here if it has none. `known` is the row {@link checkMacrocycleId}
 * already read for this number, which saves reading it again.
 */
export async function assertMacrocycleWritable(
  repos: HistoryRepos,
  program: string,
  macrocycleNum: number,
  known: MacrocycleRow | null = null,
): Promise<void> {
  const row = known ?? (await repos.macrocycle.findByNumber(program, macrocycleNum));
  if (row) {
    if (row.origin === 'imported') throw readOnly(program, macrocycleNum);
    return;
  }
  const dashboard = await dashboardOrNull(repos, program);
  if (dashboard?.macrocycleNum !== macrocycleNum) throw unknownNumber(program, macrocycleNum);
  await repos.macrocycle.ensure([currentRow(dashboard)]);
}

/**
 * Places the rows of an import path that takes macrocycle numbers from a file
 * (`POST lift-records/import` and flag-off commits). The file's numbers only group rows, since
 * stored numbers follow dates (decision 2). `rows` are the rows to create, and `pairedNums`
 * the stored macrocycles, by file number, that the group's other rows were found in.
 *
 * - A new row of a group whose other rows are stored in `live` or `legacy` macrocycles joins the
 *   last of those to start by its date, or the first of them for an earlier session, unless the
 *   next stored macrocycle has started by then. So a re-uploaded sheet that grew joins the
 *   macrocycles its first upload formed, sessions added before or between them included.
 * - Any other rows, by group, join the current macrocycle while its run is open: they start on
 *   or after its start and no more than {@link STALE_AFTER_DAYS} days after its last session.
 *   One group of a sheet joins this way: the group with rows already stored there, uploaded
 *   before or logged in the app, if there is one, so a sheet's later cycles don't merge into
 *   it, while its cycle in it keeps joining. The owner chose this over joining any
 *   `live` macrocycle on dates alone, which merged sessions logged after a cycle ended into it.
 * - Anything else forms a new `legacy` macrocycle dated by its rows, numbered past every stored
 *   one in date order. An `imported` macrocycle is never joined. Rows on the new numbers with no
 *   `macrocycle` row move past them first (see {@link moveUnstartedRows}).
 *
 * Returns each row's stored number, in `rows`' order, and the new `legacy` numbers, so undoing
 * the import can remove them. Renumbering the program by date is the caller's, after it writes.
 */
export async function placeFileRows(
  repos: HistoryRepos & Pick<RepositoryBundle, 'liftRecord'>,
  program: string,
  rows: readonly { macrocycleNum: number; date: Date }[],
  pairedNums: ReadonlyMap<number, ReadonlySet<number>>,
): Promise<{ nums: number[]; legacyNums: number[] }> {
  const ranges = dateRangesByMacrocycle(rows);
  // A backstop: row validation already rejects a file number outside 0 to
  // MAX_FILE_MACROCYCLE_NUM (`MACROCYCLE_NUM_INVALID`) before any import path gets here.
  const outOfRange = [...ranges.keys()].filter((n) => !Number.isInteger(n) || n < 0 || n > MAX_FILE_MACROCYCLE_NUM);
  if (outOfRange.length > 0) {
    throw new BadRequestException(
      `Macrocycle numbers must be from 0 to ${MAX_FILE_MACROCYCLE_NUM}; the file has ${outOfRange.join(', ')}.`,
    );
  }
  const dashboard = await dashboardOrNull(repos, program);
  // The current macrocycle can be joined, so it needs its row.
  if (dashboard) await ensureCurrentRow(repos, dashboard);
  // In start-date order, ties by number.
  const [stored, sets] = await Promise.all([
    repos.macrocycle.list(program),
    repos.liftRecord.getMacrocycleDateRanges(program),
  ]);
  // The current macrocycle has its row by now, so `stored` holds every macrocycle's number.
  const storedNums = new Set(stored.map((row) => row.macrocycleNum));
  let next = Math.max(0, ...storedNums) + 1;
  const nums: number[] = rows.map(() => 0);
  const created: NewMacrocycle[] = [];
  const current = stored.find((row) => row.macrocycleNum === dashboard?.macrocycleNum);
  // The groups that may join the current macrocycle on dates. A group with rows already stored
  // there, whether uploaded before or logged in the app, is the sheet's cycle in it, so it keeps
  // joining and no other group does. With none, the first group to join on dates takes it.
  const joiners = new Set(
    current ? [...pairedNums].filter(([, nums]) => nums.has(current.macrocycleNum)).map(([fileNum]) => fileNum) : [],
  );

  /**
   * Whether rows starting `first` join the current macrocycle on dates (decision 4): on or after
   * its start, and no more than the break that ends a run after its last session. It's checked
   * directly, so a `legacy` macrocycle formed inside its dates doesn't shut it.
   */
  const continuesRun = (row: MacrocycleRow, first: Date): boolean => {
    const day = toUTCMidnight(first);
    const lastSet = sets.get(row.macrocycleNum)?.last;
    const lastSession = lastSet && lastSet > row.startDate ? toUTCMidnight(lastSet) : row.startDate;
    return day >= row.startDate && (day.getTime() - lastSession.getTime()) / DAY_MS <= STALE_AFTER_DAYS;
  };
  /** Places `indexes` by date alone: the current macrocycle while its run is open, else a new one. */
  const placeByDate = (fileNum: number, indexes: readonly number[]): void => {
    const dates = indexes.map((i) => rows[i]?.date ?? new Date(NaN));
    const first = new Date(Math.min(...dates.map((d) => d.getTime())));
    const last = new Date(Math.max(...dates.map((d) => d.getTime())));
    let macrocycleNum: number;
    if ((joiners.size === 0 || joiners.has(fileNum)) && current && continuesRun(current, first)) {
      joiners.add(fileNum);
      macrocycleNum = current.macrocycleNum;
    } else {
      macrocycleNum = next++;
      created.push({
        program,
        macrocycleNum,
        startDate: toUTCMidnight(first),
        endDate: toUTCMidnight(last),
        status: 'unknown',
        origin: 'legacy',
      });
    }
    for (const i of indexes) nums[i] = macrocycleNum;
  };

  const byDate = [...ranges].sort(([a, x], [b, y]) => x.first.getTime() - y.first.getTime() || a - b);
  for (const [fileNum] of byDate) {
    const paired = pairedNums.get(fileNum);
    // The joinable macrocycles holding the group's stored rows, in start-date order.
    const anchors = stored.filter((r) => r.origin !== 'imported' && paired?.has(r.macrocycleNum));
    const unplaced: number[] = [];
    rows.forEach((r, i) => {
      if (r.macrocycleNum !== fileNum) return;
      const date = toUTCMidnight(r.date);
      // The last anchor started by the row's date, or the first for an earlier session.
      const anchor = anchors.filter((a) => a.startDate <= date).pop() ?? anchors[0];
      const nextStart = anchor && stored.find((s) => s.startDate > anchor.startDate)?.startDate;
      if (anchor && !(nextStart && date >= nextStart)) nums[i] = anchor.macrocycleNum;
      else unplaced.push(i);
    });
    if (unplaced.length > 0) placeByDate(fileNum, unplaced);
  }
  if (created.length > 0) await moveUnstartedRows(repos, program, storedNums, next - created.length - 1, next - 1);
  await repos.macrocycle.createMany(created);
  return { nums, legacyNums: created.map((m) => m.macrocycleNum) };
}

/**
 * An import batch's pre-image keys its sets by natural key, which starts with a digit, so a
 * `legacy` row the import created is recorded under this prefix instead.
 */
export const LEGACY_ROW_KEY = 'macrocycle-row:';

/** Pre-image entries for the `legacy` rows an import created. */
export function legacyRowsPreImage(macrocycleNums: readonly number[]): ImportPreImage {
  return Object.fromEntries(
    macrocycleNums.map((macrocycleNum) => [`${LEGACY_ROW_KEY}${macrocycleNum}`, { kind: 'created', wrote: { macrocycleNum } }]),
  );
}

/**
 * Drops the keys on deleted macrocycles from `program`'s lift-records batches: a renumbering
 * may move another macrocycle onto the number, and undoing the batch would then delete that
 * one's sets (#1199). `deleted` names the numbers that are gone: those `on` it, or all `except`
 * the ones kept. Returns how many batches changed.
 */
export async function forgetBatchKeys(
  repos: Pick<RepositoryBundle, 'importBatch'>,
  program: string,
  deleted: KeyNumbers,
): Promise<number> {
  return tracer.startActiveSpan('macrocycle.forget_batch_keys', async (span) => {
    try {
      const isDeleted = (n: number) => ('on' in deleted ? deleted.on.includes(n) : !deleted.except.includes(n));
      const updates = [];
      let dropped = 0;
      for (const batch of await repos.importBatch.listWithKeysOn(program, 'lift-records', deleted)) {
        const kept = Object.entries(batch.preImage).filter(([key]) => {
          const num = preImageKeyNumber(key);
          return num === null || !isDeleted(num);
        });
        const gone = Object.keys(batch.preImage).length - kept.length;
        if (gone === 0) continue;
        updates.push({ id: batch.id, preImage: Object.fromEntries(kept) });
        dropped += gone;
      }
      await repos.importBatch.updatePreImages(updates);
      span.setAttribute('import_batch.batches_changed', updates.length);
      span.setAttribute('import_batch.keys_dropped', dropped);
      return updates.length;
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Splits a lift-records pre-image's keys into set keys and the `legacy` rows' numbers. */
export function splitLegacyRowKeys(keys: readonly string[]): { setKeys: string[]; legacyNums: number[] } {
  return {
    setKeys: keys.filter((k) => !k.startsWith(LEGACY_ROW_KEY)),
    legacyNums: keys.filter((k) => k.startsWith(LEGACY_ROW_KEY)).map((k) => Number(k.slice(LEGACY_ROW_KEY.length))),
  };
}

/**
 * Undoes {@link placeFileRows} for an undone import: removes each of `macrocycleNums` that is
 * `legacy` and has no sets left, from every table that holds a number, and drops other batches'
 * keys on it. The caller passes the `legacy` macrocycles the import created and the numbers its
 * sets were on, so a `legacy` macrocycle another import created, which this one's sets joined,
 * goes once both imports are undone. A number the lifter logged sets into since keeps its row.
 */
export async function removeEmptyLegacyRows(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord' | 'importBatch'>,
  program: string,
  macrocycleNums: readonly number[],
): Promise<void> {
  if (macrocycleNums.length === 0) return;
  const [rows, ranges] = await Promise.all([
    repos.macrocycle.list(program),
    repos.liftRecord.getMacrocycleDateRanges(program),
  ]);
  const isEmpty = (r: MacrocycleRow) =>
    r.origin === 'legacy' && macrocycleNums.includes(r.macrocycleNum) && !ranges.has(r.macrocycleNum);
  const empty = rows.filter(isEmpty).map((r) => r.macrocycleNum);
  if (empty.length === 0) return;
  await repos.macrocycle.delete(program, empty);
  await forgetBatchKeys(repos, program, { on: empty });
  // The rows the import moved past its new numbers come back down.
  const kept = new Set(rows.filter((r) => !isEmpty(r)).map((r) => r.macrocycleNum));
  const highest = Math.max(0, ...kept);
  await moveUnstartedRows(repos, program, kept, highest, highest);
}

/**
 * Moves the rows on numbers above `above` that have no `macrocycle` row (`stored` holds the
 * numbers that have one) onto the numbers right after `highest`, in order. Those are rows a page
 * wrote before the program had a macrocycle on the number, such as a focus state saved before
 * initializing, and they belong to the next macrocycle to start, which takes the number after the
 * highest stored one. Without this, a new `legacy` macrocycle numbered there would take them, and
 * undoing its import would delete them. With renumbering on, the renumbering moves them again
 * once the numbers close up.
 */
async function moveUnstartedRows(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  program: string,
  stored: ReadonlySet<number>,
  above: number,
  highest: number,
): Promise<void> {
  const unstarted = (await repos.macrocycle.numbersInUse(program, above)).filter((n) => !stored.has(n));
  const changes = new Map(
    unstarted.map((n, i): [number, number] => [n, highest + 1 + i]).filter(([from, to]) => from !== to),
  );
  if (changes.size === 0) return;
  try {
    await repos.macrocycle.rewriteNumbers(program, changes);
  } catch (err) {
    // Logged as the renumbering logs its refusals, so both show up in the same search.
    const detail = err instanceof MacrocycleNumberConflictError ? err.detail : undefined;
    writeLogger.warn(
      {
        program,
        moves: Object.fromEntries(changes),
        table: detail?.table,
        heldNumber: detail?.heldNumber,
        error: err instanceof Error ? err.message : String(err),
      },
      'Moving unstarted rows failed',
    );
    throw err;
  }
}

/**
 * The status a macrocycle closes with when the next one starts (decisions 6 and 7): `completed`
 * once every workout of the program has a logged set, else `abandoned`, since starting the
 * next one is a restart. A workout number past the program's length doesn't count towards it.
 * With no known length nothing can tell, so it's `unknown`.
 */
export function closingStatus(loggedWorkoutNums: ReadonlySet<number>, programWorkouts: number): MacrocycleStatus {
  if (programWorkouts === 0) return 'unknown';
  const logged = [...loggedWorkoutNums].filter((n) => n >= 1 && n <= programWorkouts).length;
  return logged >= programWorkouts ? 'completed' : 'abandoned';
}

/**
 * A row's dates as the list shows them: widened to cover its sets, since a set logged into a
 * closed macrocycle, or uploaded into a legacy one, doesn't move the stored dates. A missing
 * end date stays missing.
 */
export function datesAsRead(
  row: Pick<MacrocycleRow, 'startDate' | 'endDate'>,
  sets: DateRange | undefined,
): Pick<MacrocycleRow, 'startDate' | 'endDate'> {
  if (!sets) return { startDate: row.startDate, endDate: row.endDate };
  return {
    startDate: sets.first < row.startDate ? toUTCMidnight(sets.first) : row.startDate,
    endDate: row.endDate && sets.last > row.endDate ? toUTCMidnight(sets.last) : row.endDate,
  };
}

/**
 * A macrocycle's status as it reads today (decision 1): an `in-progress` row whose last session
 * is more than 14 days before `today` reads as `abandoned`, so it can't go stale. Not the
 * current macrocycle, which is still current after a long break, and not a status the lifter
 * chose. With no sessions, the start date stands in for the last one.
 */
export function statusAsRead(
  row: Pick<MacrocycleRow, 'status' | 'statusChosen' | 'startDate'>,
  context: { current: boolean; lastSession: Date | null; today: Date },
): MacrocycleStatus {
  if (row.status !== 'in-progress' || row.statusChosen || context.current) return row.status;
  const last = context.lastSession ?? row.startDate;
  const days = (toUTCMidnight(context.today).getTime() - toUTCMidnight(last).getTime()) / DAY_MS;
  return days > STALE_AFTER_DAYS ? 'abandoned' : 'in-progress';
}
