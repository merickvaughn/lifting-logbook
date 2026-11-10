import { ConflictException, NotFoundException } from '@nestjs/common';
import { MacrocycleDashboard, toUTCMidnight } from '@lifting-logbook/core';
import { MacrocycleStatus } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import { ProgramNotFoundError } from '../ports/errors';

/**
 * Macrocycle history (ADR-042): one `macrocycle` row per macrocycle, numbers allocated from
 * what's stored, and the write guard that keeps imported history read-only.
 */

type HistoryRepos = Pick<RepositoryBundle, 'macrocycle' | 'macrocycleDashboard'>;

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
 * can't land on an imported or legacy one. The dashboard counts too, for a current macrocycle
 * the previous API revision started without a row.
 */
export async function nextMacrocycleNumber(repos: HistoryRepos, program: string): Promise<number> {
  const [highest, dashboard] = await Promise.all([
    repos.macrocycle.highestNumber(program),
    dashboardOrNull(repos, program),
  ]);
  return Math.max(highest, dashboard?.macrocycleNum ?? 0) + 1;
}

/**
 * The current macrocycle's row, created as `live` if it has none: the previous API revision
 * started macrocycles without one (see the migration's deploy note).
 */
export async function ensureCurrentRow(
  repos: Pick<RepositoryBundle, 'macrocycle'>,
  dashboard: MacrocycleDashboard,
): Promise<MacrocycleRow> {
  const row = await repos.macrocycle.findByNumber(dashboard.program, dashboard.macrocycleNum);
  if (row) return row;
  return repos.macrocycle.create({
    program: dashboard.program,
    macrocycleNum: dashboard.macrocycleNum,
    startDate: toUTCMidnight(dashboard.macrocycleDate),
    status: 'in-progress',
    origin: 'live',
  });
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
 * Guards a write scoped to one macrocycle (proposal decision 2): an `imported` macrocycle is
 * read-only (409 `macrocycle-read-only`) and a number the program doesn't have is a 404
 * (`macrocycle-not-found`). `live` and `legacy` macrocycles stay writable. The current
 * macrocycle gets its row here if it has none.
 */
export async function assertMacrocycleWritable(
  repos: HistoryRepos,
  program: string,
  macrocycleNum: number,
): Promise<MacrocycleRow> {
  const row = await repos.macrocycle.findByNumber(program, macrocycleNum);
  if (row) {
    if (row.origin === 'imported') throw readOnly(program, macrocycleNum);
    return row;
  }
  const dashboard = await dashboardOrNull(repos, program);
  if (dashboard?.macrocycleNum === macrocycleNum) return ensureCurrentRow(repos, dashboard);
  throw unknownNumber(program, macrocycleNum);
}

/**
 * Guards an import path that takes macrocycle numbers from a file (`POST lift-records/import`
 * and flag-off commits). Rows can't join an `imported` macrocycle, and a number with no row
 * gets a `legacy` one dated by the file's rows, so every stored number has a row (decision 2).
 * Counting duplicates and renumbering by date come with #1199.
 */
export async function ensureFileNumberRows(
  repos: HistoryRepos,
  program: string,
  rows: readonly { macrocycleNum: number; date: Date }[],
): Promise<void> {
  const ranges = new Map<number, { first: Date; last: Date }>();
  for (const { macrocycleNum, date } of rows) {
    const range = ranges.get(macrocycleNum);
    if (!range) ranges.set(macrocycleNum, { first: date, last: date });
    else {
      if (date < range.first) range.first = date;
      if (date > range.last) range.last = date;
    }
  }
  const dashboard = await dashboardOrNull(repos, program);
  for (const [macrocycleNum, { first, last }] of [...ranges].sort(([a], [b]) => a - b)) {
    const row = await repos.macrocycle.findByNumber(program, macrocycleNum);
    if (row?.origin === 'imported') throw readOnly(program, macrocycleNum);
    if (row) continue;
    if (dashboard?.macrocycleNum === macrocycleNum) {
      await ensureCurrentRow(repos, dashboard);
      continue;
    }
    await repos.macrocycle.create({
      program,
      macrocycleNum,
      startDate: toUTCMidnight(first),
      endDate: toUTCMidnight(last),
      status: 'unknown',
      origin: 'legacy',
    });
  }
}

/**
 * The status a macrocycle closes with when the next one starts (decisions 6 and 7): `completed`
 * once every workout of the program has a logged set, else `abandoned`, since starting the
 * next one is a restart. With no known length nothing can tell, so it's `unknown`.
 */
export function closingStatus(loggedWorkouts: number, programWorkouts: number): MacrocycleStatus {
  if (programWorkouts === 0) return 'unknown';
  return loggedWorkouts >= programWorkouts ? 'completed' : 'abandoned';
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
