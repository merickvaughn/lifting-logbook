import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ImportPreImage, MacrocycleDashboard, toUTCMidnight } from '@lifting-logbook/core';
import { MacrocycleStatus } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import { DateRange, dateRangesByMacrocycle } from '../ports/ILiftRecordRepository';
import { MacrocycleRow, NewMacrocycle } from '../ports/IMacrocycleRepository';
import { ProgramNotFoundError } from '../ports/errors';

/**
 * Macrocycle history (ADR-042): one `macrocycle` row per macrocycle, numbers allocated from
 * what's stored, and the write guard that keeps imported history read-only.
 */

type HistoryRepos = Pick<RepositoryBundle, 'macrocycle' | 'macrocycleDashboard'>;

/** A break longer than this ends a run (proposal decision 4); an older `in-progress` reads as `abandoned`. */
export const STALE_AFTER_DAYS = 14;

/**
 * The highest macrocycle number a file may carry: the bound `POST lift-records` already
 * applies. Numbers are allocated past the highest stored one, so an unbounded file number
 * would push every later macrocycle past it, or overflow the column. The lowest is 0, not
 * the 1 a live macrocycle starts at: spreadsheet exports number a first cycle 0
 * (`packages/core/tests/fixtures/lift_records.csv`).
 */
export const MAX_FILE_MACROCYCLE_NUM = 1000;

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
 * Takes the macrocycle lock exclusively for a start or a delete that already holds it shared and
 * would move a number (#1199), waiting as an import does, then a 409 `macrocycle-busy`. Two
 * such requests waiting on each other is a deadlock Postgres breaks by refusing one, which gets
 * the same 409.
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

/** Whether rows dated `first` to `last` belong in `row` (proposal decision 2). */
function fitsDates(row: Pick<MacrocycleRow, 'startDate' | 'endDate'>, first: Date, last: Date, current: boolean): boolean {
  if (toUTCMidnight(first) < row.startDate) return false;
  return current || row.endDate === null || toUTCMidnight(last) <= row.endDate;
}

/**
 * Places the rows of an import path that takes macrocycle numbers from a file
 * (`POST lift-records/import` and flag-off commits). The file's numbers only group rows, since
 * stored numbers follow dates (decision 2): a group joins the stored macrocycle with its number
 * when its dates fall inside that one's dates, or after its start if it's the current one. Any
 * other group, including one numbered like an `imported` macrocycle, which rows never join, gets
 * a new `legacy` macrocycle dated by its rows, numbered past every stored one in date order. A
 * file number must still be from 0 to {@link MAX_FILE_MACROCYCLE_NUM}.
 *
 * Returns each file number's stored number, and the new `legacy` numbers, so undoing the import
 * can remove them. Renumbering the program by date is the caller's, after it writes the rows.
 */
export async function placeFileRows(
  repos: HistoryRepos,
  program: string,
  rows: readonly { macrocycleNum: number; date: Date }[],
): Promise<{ placed: Map<number, number>; legacyNums: number[] }> {
  const ranges = dateRangesByMacrocycle(rows);
  const outOfRange = [...ranges.keys()].filter((n) => !Number.isInteger(n) || n < 0 || n > MAX_FILE_MACROCYCLE_NUM);
  if (outOfRange.length > 0) {
    throw new BadRequestException(
      `Macrocycle numbers must be from 0 to ${MAX_FILE_MACROCYCLE_NUM}; the file has ${outOfRange.join(', ')}.`,
    );
  }
  const dashboard = await dashboardOrNull(repos, program);
  // The current macrocycle can be joined, so it needs its row.
  if (dashboard) await ensureCurrentRow(repos, dashboard);
  const storedByNumber = new Map((await repos.macrocycle.list(program)).map((row) => [row.macrocycleNum, row]));
  let next = await nextMacrocycleNumber(repos, program, dashboard);
  const placed = new Map<number, number>();
  const legacyNums: number[] = [];
  const byDate = [...ranges].sort(([a, x], [b, y]) => x.first.getTime() - y.first.getTime() || a - b);
  for (const [fileNum, { first, last }] of byDate) {
    const row = storedByNumber.get(fileNum);
    if (row && row.origin !== 'imported' && fitsDates(row, first, last, dashboard?.macrocycleNum === fileNum)) {
      placed.set(fileNum, fileNum);
      continue;
    }
    const macrocycleNum = next++;
    await repos.macrocycle.create({
      program,
      macrocycleNum,
      startDate: toUTCMidnight(first),
      endDate: toUTCMidnight(last),
      status: 'unknown',
      origin: 'legacy',
    });
    placed.set(fileNum, macrocycleNum);
    legacyNums.push(macrocycleNum);
  }
  return { placed, legacyNums };
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

/** Splits a lift-records pre-image's keys into set keys and the `legacy` rows' numbers. */
export function splitLegacyRowKeys(keys: readonly string[]): { setKeys: string[]; legacyNums: number[] } {
  return {
    setKeys: keys.filter((k) => !k.startsWith(LEGACY_ROW_KEY)),
    legacyNums: keys.filter((k) => k.startsWith(LEGACY_ROW_KEY)).map((k) => Number(k.slice(LEGACY_ROW_KEY.length))),
  };
}

/**
 * Undoes {@link placeFileRows} for an undone import: removes each of `macrocycleNums`
 * that is still `legacy` and has no sets left. A number the lifter logged sets into since
 * keeps its row.
 */
export async function removeEmptyLegacyRows(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord'>,
  program: string,
  macrocycleNums: readonly number[],
): Promise<void> {
  if (macrocycleNums.length === 0) return;
  const [rows, ranges] = await Promise.all([
    repos.macrocycle.list(program),
    repos.liftRecord.getMacrocycleDateRanges(program),
  ]);
  const empty = rows
    .filter((r) => r.origin === 'legacy' && macrocycleNums.includes(r.macrocycleNum) && !ranges.has(r.macrocycleNum))
    .map((r) => r.macrocycleNum);
  await repos.macrocycle.delete(program, empty);
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
