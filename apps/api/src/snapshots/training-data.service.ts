import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ImportPreImage, programWorkoutKeys } from '@lifting-logbook/core';
import { MacrocycleStatus, NON_CYCLE_PROGRAM, TrainingDataCounts } from '@lifting-logbook/types';
import { ProgramNotFoundError } from '../ports/errors';
import { RepositoryBundle } from '../ports/factory';
import { StoredSnapshotSummary } from '../ports/IDataSnapshotRepository';
import {
  NUMBERED_TRAINING_TABLES,
  TRAINING_TABLES,
  TrainingData,
  TrainingRow,
  liftRecordRows,
  macrocycleRows,
} from '../ports/ITrainingDataRepository';
import { closingStatus, lockForAssignedImport } from '../programs/macrocycle-history.util';
import { renumberPreImageKeys, renumberProgram } from '../programs/macrocycle-renumbering';
import { NON_CYCLE_MACROCYCLE_NUM } from '../programs/non-cycle.util';

/** How long a snapshot can be restored or downloaded (proposal decision 21). */
export const SNAPSHOT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type Repos = Pick<
  RepositoryBundle,
  'trainingData' | 'dataSnapshot' | 'macrocycle' | 'macrocycleDashboard' | 'importBatch' | 'liftRecord' | 'liftingProgramSpec'
>;

/** Every program a row names, in name order. */
function programsIn(data: TrainingData): string[] {
  return [...new Set(TRAINING_TABLES.flatMap((table) => data[table].map((row) => row.program)))].sort();
}

/**
 * Clear data (proposal decision 20, #1309): saves a snapshot of every cleared table, then clears
 * them, in the caller's transaction. Takes the import and macrocycle locks first, so no import or
 * page write runs alongside it. When the stored counts differ from `confirmed`, what the lifter
 * agreed to clear isn't what's there, so nothing changes and it's a 409. When the snapshot can't
 * be saved, nothing is cleared and it's a 503.
 */
export async function clearTrainingData(
  repos: Repos,
  confirmed: TrainingDataCounts,
  now: Date,
): Promise<StoredSnapshotSummary> {
  await lockForAssignedImport(repos);
  const counts = await repos.trainingData.counts();
  if (TRAINING_TABLES.some((table) => counts[table] !== confirmed[table])) {
    throw new ConflictException({
      statusCode: 409,
      code: 'counts-changed',
      message: 'Your data has changed since you confirmed what to clear, so nothing was cleared. Check the counts and confirm again.',
      error: 'Conflict',
      counts,
    });
  }
  const data = await repos.trainingData.read();
  let snapshot: StoredSnapshotSummary;
  try {
    snapshot = await repos.dataSnapshot.create({
      kind: 'clear',
      scope: { programs: programsIn(data) },
      counts,
      data,
      expiresAt: new Date(now.getTime() + SNAPSHOT_RETENTION_DAYS * DAY_MS),
    });
  } catch (err) {
    throw new ServiceUnavailableException(
      'Your data couldn’t be backed up, so nothing was cleared. Please try again in a moment.',
      { cause: err },
    );
  }
  await repos.trainingData.clear();
  return snapshot;
}

/** Moves every numbered row of `program` by `move`, which returns the row's new numbers. */
function moveRows(
  data: TrainingData,
  program: string,
  move: (row: TrainingRow) => Partial<Pick<TrainingRow, 'macrocycleNum' | 'workoutNum'>>,
): void {
  for (const table of NUMBERED_TRAINING_TABLES) {
    data[table] = data[table].map((row) => (row.program === program ? { ...row, ...move(row) } : row));
  }
}

/**
 * Puts a snapshot's macrocycles past every number `program` holds now, so none lands on a
 * macrocycle started since the clear. Renumbering afterwards orders them all by date.
 */
async function placeAfterStored(repos: Repos, data: TrainingData, program: string): Promise<void> {
  const offset = Math.max(0, ...(await repos.macrocycle.numbersInUse(program)));
  if (offset === 0) return;
  const numbers = NUMBERED_TRAINING_TABLES.flatMap((table) => data[table])
    .filter((row) => row.program === program)
    .flatMap((row) => row.macrocycleNum ?? []);
  const changes = new Map(numbers.map((n) => [n, n + offset]));
  moveRows(data, program, (row) => (row.macrocycleNum === undefined ? {} : { macrocycleNum: row.macrocycleNum + offset }));
  data.importBatches = data.importBatches.map((batch) => {
    if (batch.program !== program || batch.destination !== 'lift-records') return batch;
    // A lift-records batch's pre-image, as the import stored it.
    const preImage = renumberPreImageKeys(batch.preImage as ImportPreImage, changes);
    return preImage ? { ...batch, preImage } : batch;
  });
}

/**
 * Non-cycle workouts share one macrocycle that is never renumbered (decision 23), so a
 * snapshot's workouts take numbers past the ones logged since the clear instead.
 */
async function placeNonCycleAfterStored(repos: Repos, data: TrainingData): Promise<void> {
  const logged = await repos.liftRecord.getLoggedWorkoutNums(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
  const offset = Math.max(0, ...logged);
  if (offset === 0) return;
  moveRows(data, NON_CYCLE_PROGRAM, (row) => (row.workoutNum === undefined ? {} : { workoutNum: row.workoutNum + offset }));
}

/**
 * When `program` has a dashboard now, the snapshot's stays out, and the macrocycle it pointed at
 * comes back as history: it ends on its last set, or its start with none, with the status its
 * sets give it unless the lifter chose one, as starting the next macrocycle closes one.
 */
async function closeReplacedCurrent(repos: Repos, data: TrainingData, program: string): Promise<void> {
  const dashboard = data.macrocycleDashboards.find((d) => d.program === program);
  if (!dashboard || !(await hasDashboard(repos, program))) return;
  const macrocycles = macrocycleRows(data);
  const index = macrocycles.findIndex((m) => m.program === program && m.macrocycleNum === dashboard.macrocycleNum);
  const row = macrocycles[index];
  if (!row || row.endDate) return;
  const sets = liftRecordRows(data).filter((r) => r.program === program && r.macrocycleNum === row.macrocycleNum);
  const last = sets.reduce<Date | null>((latest, r) => (!latest || r.date > latest ? r.date : latest), null);
  let status: MacrocycleStatus = row.status;
  if (!row.statusChosen) {
    status = closingStatus(new Set(sets.map((r) => r.workoutNum)), await programWorkouts(repos, program));
  }
  macrocycles[index] = { ...row, endDate: last ?? row.startDate, status };
}

async function hasDashboard(repos: Repos, program: string): Promise<boolean> {
  try {
    await repos.macrocycleDashboard.getMacrocycleDashboard(program);
    return true;
  } catch (err) {
    // No dashboard stored now, so the snapshot's goes back in.
    if (err instanceof ProgramNotFoundError) return false;
    throw err;
  }
}

/** How many workouts the program has: none for a custom program deleted since, which closes as `unknown`. */
async function programWorkouts(repos: Repos, program: string): Promise<number> {
  return programWorkoutKeys(program, await repos.liftingProgramSpec.getProgramSpec(program)).length;
}

/**
 * Restore (proposal decision 21, #1309): puts a snapshot's rows back without overwriting
 * anything stored since the clear, then deletes the snapshot, in the caller's transaction. Its
 * macrocycles go past every stored number and are then renumbered by start date with the rest,
 * so a macrocycle started since stays separate. A program's dashboard, a lift's training max and
 * a modification's own max stored since are kept, and where the dashboard is kept the snapshot's
 * current macrocycle comes back closed. An expired or unknown snapshot is a 404.
 */
export async function restoreSnapshot(repos: Repos, id: string, now: Date): Promise<TrainingDataCounts> {
  await lockForAssignedImport(repos);
  const snapshot = await repos.dataSnapshot.get(id, now);
  if (!snapshot) throw new NotFoundException('This backup has expired or was deleted, so it can’t be restored.');
  const data = snapshot.data;
  const programs = programsIn(data);
  for (const program of programs) {
    if (program === NON_CYCLE_PROGRAM) {
      await placeNonCycleAfterStored(repos, data);
    } else {
      await placeAfterStored(repos, data, program);
      await closeReplacedCurrent(repos, data, program);
    }
  }
  const restored = await repos.trainingData.insertMissing(data);
  await repos.dataSnapshot.delete(id);
  for (const program of programs) {
    if (program !== NON_CYCLE_PROGRAM) await renumberProgram(repos, program);
  }
  return restored;
}
