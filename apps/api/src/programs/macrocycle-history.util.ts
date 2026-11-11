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
    message: `Program '${program}' has no macrocycle ${macrocycleNum}.`,
    error: 'Not Found',
  });
}

/**
 * The stable id of the current macrocycle (`dashboard`, already loaded by the caller), for a
 * page to send back with its writes. It gets its row here if the previous API revision started
 * it without one. Creating that row is a macrocycle write, so it takes the shared lock first;
 * while an import holds it the page gets no id, and its writes are still accepted without one
 * until #1200. No dashboard means no macrocycle, and no id.
 */
export async function macrocycleIdFor(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  dashboard: MacrocycleDashboard | null,
): Promise<string | undefined> {
  if (!dashboard) return undefined;
  const row = await repos.macrocycle.findByNumber(dashboard.program, dashboard.macrocycleNum);
  if (row) return row.id;
  if (!(await repos.macrocycle.tryLockShared())) return undefined;
  await repos.macrocycle.ensure([currentRow(dashboard)]);
  // `ensure` doesn't return ids, and a concurrent request may have made the row.
  return (await repos.macrocycle.findByNumber(dashboard.program, dashboard.macrocycleNum))?.id;
}

/**
 * The header a page sends its macrocycle's stable id in (proposal decision 3, #1198). `@Headers`
 * matches it case-insensitively. `main.ts`'s CORS options allow it.
 */
export { MACROCYCLE_ID_HEADER } from '@lifting-logbook/types';

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

/** An import's lock wait ran out. Written for the person importing, who caused neither. */
function writesInProgress(action: 'import' | 'undo'): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'macrocycle-busy',
    message: `Your workouts are being saved. Try the ${action} again in a moment.`,
    error: 'Conflict',
  });
}

function unknownId(program: string, macrocycleId: string): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: 'macrocycle-not-found',
    message: `Program '${program}' has no macrocycle with id '${macrocycleId}'.`,
    error: 'Not Found',
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
 * can be counted.
 */
export async function checkMacrocycleId(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  program: string,
  macrocycleNum: number,
  macrocycleId: string | undefined,
  route: string,
): Promise<void> {
  await lockForMacrocycleWrite(repos);
  if (!macrocycleId) {
    writeLogger.log({ route, program }, 'Macrocycle write without an id (#1198)');
    return;
  }
  const row = await repos.macrocycle.findById(macrocycleId);
  if (!row || row.program !== program) throw unknownId(program, macrocycleId);
  if (row.macrocycleNum !== macrocycleNum) throw moved(program, row.macrocycleNum);
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
 * Guards a write scoped to one macrocycle (proposal decision 2): an `imported` macrocycle is
 * read-only (409 `macrocycle-read-only`) and a number the program doesn't have is a 404
 * (`macrocycle-not-found`). `live` and `legacy` macrocycles stay writable. The current
 * macrocycle gets its row here if it has none.
 */
export async function assertMacrocycleWritable(
  repos: HistoryRepos,
  program: string,
  macrocycleNum: number,
): Promise<void> {
  const row = await repos.macrocycle.findByNumber(program, macrocycleNum);
  if (row) {
    if (row.origin === 'imported') throw readOnly(program, macrocycleNum);
    return;
  }
  const dashboard = await dashboardOrNull(repos, program);
  if (dashboard?.macrocycleNum !== macrocycleNum) throw unknownNumber(program, macrocycleNum);
  await repos.macrocycle.ensure([currentRow(dashboard)]);
}

/**
 * Guards an import path that takes macrocycle numbers from a file (`POST lift-records/import`
 * and flag-off commits). Rows can't join an `imported` macrocycle, a number must be from 0 to
 * {@link MAX_FILE_MACROCYCLE_NUM}, and a number with no row gets a `legacy` one dated by the
 * file's rows, so every stored number has a row (decision 2). Returns the numbers given a
 * `legacy` row, so undoing the import can remove them. Counting duplicates and renumbering by
 * date come with #1199.
 */
export async function ensureFileNumberRows(
  repos: HistoryRepos,
  program: string,
  rows: readonly { macrocycleNum: number; date: Date }[],
): Promise<number[]> {
  const ranges = dateRangesByMacrocycle(rows);
  const outOfRange = [...ranges.keys()].filter((n) => !Number.isInteger(n) || n < 0 || n > MAX_FILE_MACROCYCLE_NUM);
  if (outOfRange.length > 0) {
    throw new BadRequestException(
      `Macrocycle numbers must be from 0 to ${MAX_FILE_MACROCYCLE_NUM}; the file has ${outOfRange.join(', ')}.`,
    );
  }
  const [stored, dashboard] = await Promise.all([repos.macrocycle.list(program), dashboardOrNull(repos, program)]);
  const storedByNumber = new Map(stored.map((row) => [row.macrocycleNum, row]));
  const missing: NewMacrocycle[] = [];
  for (const [macrocycleNum, { first, last }] of [...ranges].sort(([a], [b]) => a - b)) {
    const row = storedByNumber.get(macrocycleNum);
    if (row?.origin === 'imported') throw readOnly(program, macrocycleNum);
    if (row) continue;
    missing.push(
      dashboard?.macrocycleNum === macrocycleNum
        ? currentRow(dashboard)
        : {
            program,
            macrocycleNum,
            startDate: toUTCMidnight(first),
            endDate: toUTCMidnight(last),
            status: 'unknown',
            origin: 'legacy',
          },
    );
  }
  await repos.macrocycle.ensure(missing);
  return missing.filter((m) => m.origin === 'legacy').map((m) => m.macrocycleNum);
}

/**
 * An import batch's pre-image keys its sets by natural key, which starts with a digit, so a
 * `legacy` row the import created is recorded under this prefix instead.
 */
const LEGACY_ROW_KEY = 'macrocycle-row:';

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
 * Undoes {@link ensureFileNumberRows} for an undone import: removes each of `macrocycleNums`
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
