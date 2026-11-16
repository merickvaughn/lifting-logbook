import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  ImportPreImage,
  LiftRecordExportRow,
  classifyLiftRecordRows,
  liftRecordNaturalKey,
  programWorkoutKeys,
} from '@lifting-logbook/core';
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
import {
  LEGACY_ROW_KEY,
  NON_CYCLE_ROW_KEY,
  closingStatus,
  lockForAssignedImport,
} from '../programs/macrocycle-history.util';
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
      createdAt: now,
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

type SetRow = LiftRecordExportRow & TrainingRow;

/** A lift-records batch's pre-image with only the keys `keep` accepts, or null when it keeps all. */
function filterPreImage(batch: TrainingRow, keep: (key: string) => boolean): ImportPreImage | null {
  // A lift-records batch's pre-image, as the import stored it.
  const entries = Object.entries(batch['preImage'] as ImportPreImage);
  const kept = entries.filter(([key]) => keep(key));
  return kept.length === entries.length ? null : Object.fromEntries(kept);
}

function isLiftRecordsBatch(batch: TrainingRow): boolean {
  return batch['destination'] === 'lift-records';
}

/**
 * Leaves out the snapshot's sets that are stored again, by decision 13's rule (one date, one lift
 * under any spelling, one set number, in any program), as when the lifter imported the clear's
 * download before restoring. A cycle macrocycle left with no sets goes with all its rows, unless
 * it's the current one and the program's dashboard comes back with it; a non-cycle workout left
 * with no sets loses its rows, and the shared non-cycle macrocycle stays. Batch keys naming what
 * went are dropped, and a batch left with none goes.
 */
async function skipStoredSets(repos: Repos, data: TrainingData): Promise<void> {
  const sets: SetRow[] = liftRecordRows(data);
  if (sets.length === 0) return;
  const slots = new Map(sets.map((r) => [`${r.date.toISOString()}|${r.lift}`, { date: r.date, lift: r.lift }]));
  const stored = await repos.liftRecord.findStoredSets([...slots.values()]);
  if (stored.length === 0) return;
  // Each program's macrocycle numbers read apart, so two programs' sets that look alike aren't
  // taken for one set repeated.
  const cycles = new Map<string, number>();
  const cycleOf = (r: SetRow): number => {
    const key = `${r.program}|${r.macrocycleNum}`;
    const n = cycles.get(key) ?? cycles.size + 1;
    cycles.set(key, n);
    return n;
  };
  const classified = classifyLiftRecordRows(sets, (r) => ({ ...r, macrocycleNum: cycleOf(r) }), stored);
  // Only a set paired with a stored one is left out: the snapshot's sets were stored together, so
  // none of them repeats another, and each keeps its own occurrence.
  const skipped = new Set(classified.filter((c) => c.kind === 'skip' && c.paired !== undefined).map((c) => c.row));
  if (skipped.size === 0) return;
  data.liftRecords = sets.filter((r) => !skipped.has(r));

  const cycleKey = (program: string, num: number | undefined) => `${program}|${num}`;
  const workoutKey = (row: TrainingRow) => `${row.macrocycleNum}|${row.workoutNum}`;
  const left = liftRecordRows(data);
  const keep = new Set(left.map((r) => cycleKey(r.program, r.macrocycleNum)));
  for (const dashboard of data.macrocycleDashboards) {
    if (!(await hasDashboard(repos, dashboard.program))) keep.add(cycleKey(dashboard.program, dashboard.macrocycleNum));
  }
  const emptied = new Set(
    sets
      .filter((r) => r.program !== NON_CYCLE_PROGRAM)
      .map((r) => cycleKey(r.program, r.macrocycleNum))
      .filter((key) => !keep.has(key)),
  );
  const nonCycleWorkouts = (rows: SetRow[]) =>
    new Set(rows.filter((r) => r.program === NON_CYCLE_PROGRAM).map(workoutKey));
  const workoutsLeft = nonCycleWorkouts(left);
  const emptiedWorkouts = new Set([...nonCycleWorkouts(sets)].filter((key) => !workoutsLeft.has(key)));
  for (const table of NUMBERED_TRAINING_TABLES) {
    data[table] = data[table].filter(
      (row) =>
        !emptied.has(cycleKey(row.program, row.macrocycleNum)) &&
        !(row.program === NON_CYCLE_PROGRAM && row.workoutNum !== undefined && emptiedWorkouts.has(workoutKey(row))),
    );
  }

  const skippedKeys = new Set([...skipped].map((r) => `${r.program}|${liftRecordNaturalKey(r)}`));
  const dropsKey = (program: string, key: string): boolean => {
    if (key.startsWith(NON_CYCLE_ROW_KEY)) return skippedKeys.has(`${NON_CYCLE_PROGRAM}|${key.slice(NON_CYCLE_ROW_KEY.length)}`);
    if (key.startsWith(LEGACY_ROW_KEY)) return emptied.has(`${program}|${key.slice(LEGACY_ROW_KEY.length)}`);
    return skippedKeys.has(`${program}|${key}`);
  };
  data.importBatches = data.importBatches.flatMap((batch) => {
    if (!isLiftRecordsBatch(batch)) return [batch];
    const preImage = filterPreImage(batch, (key) => !dropsKey(batch.program, key));
    if (!preImage) return [batch];
    // A batch with nothing left to undo goes, unless it chose a macrocycle's status.
    if (Object.keys(preImage).length === 0 && batch['macrocycles'] == null) return [];
    return [{ ...batch, preImage }];
  });
}

/**
 * Puts a snapshot's macrocycles past every number `program` holds now, so none lands on a
 * macrocycle started since the clear. Renumbering afterwards orders them all by date. A batch
 * imported since names only numbers in use: deleting a macrocycle drops its keys
 * (`forgetBatchKeys`, #1199).
 */
async function placeAfterStored(repos: Repos, data: TrainingData, program: string): Promise<void> {
  const offset = [...(await repos.macrocycle.numbersInUse(program))].reduce((n, m) => Math.max(n, m), 0);
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
 * snapshot's workouts take numbers past the ones logged since the clear instead, and so do the
 * keys its import batches hold for them, which any program's batch can (#1184). The restored
 * workouts aren't put back in date order with the ones logged since.
 */
async function placeNonCycleAfterStored(repos: Repos, data: TrainingData): Promise<void> {
  const logged = await repos.liftRecord.getLoggedWorkoutNums(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
  const offset = [...logged].reduce((n, w) => Math.max(n, w), 0);
  if (offset === 0) return;
  moveRows(data, NON_CYCLE_PROGRAM, (row) => (row.workoutNum === undefined ? {} : { workoutNum: row.workoutNum + offset }));
  data.importBatches = data.importBatches.map((batch) => {
    if (!isLiftRecordsBatch(batch)) return batch;
    const entries = Object.entries(batch['preImage'] as ImportPreImage);
    if (!entries.some(([key]) => key.startsWith(NON_CYCLE_ROW_KEY))) return batch;
    const preImage = Object.fromEntries(entries.map(([key, entry]) => [shiftNonCycleKey(key, offset), entry]));
    return { ...batch, preImage };
  });
}

/** A `non-cycle:<macrocycle>:<workout>:…` key with its workout number moved by `offset`; other keys as they are. */
export function shiftNonCycleKey(key: string, offset: number): string {
  if (!key.startsWith(NON_CYCLE_ROW_KEY)) return key;
  const [macrocycleNum, workoutNum, ...rest] = key.slice(NON_CYCLE_ROW_KEY.length).split(':');
  return `${NON_CYCLE_ROW_KEY}${[macrocycleNum, Number(workoutNum) + offset, ...rest].join(':')}`;
}

/**
 * The non-cycle macrocycle starts at its first set, so when restored sets predate the one stored
 * since the clear, it moves back to the earliest of them.
 */
async function startNonCycleAtEarliestSet(repos: Repos, data: TrainingData): Promise<void> {
  const dates = liftRecordRows(data)
    .filter((r) => r.program === NON_CYCLE_PROGRAM)
    .map((r) => r.date);
  if (dates.length === 0) return;
  const earliest = dates.reduce((a, b) => (b < a ? b : a));
  const row = await repos.macrocycle.findByNumber(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
  if (row && earliest < row.startDate) await repos.macrocycle.update(row.id, { startDate: earliest });
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
 * current macrocycle comes back closed. A set stored again since, as by importing the clear's
 * download, isn't restored twice (decision 21). An expired or unknown snapshot is a 404.
 */
export async function restoreSnapshot(repos: Repos, id: string, now: Date): Promise<TrainingDataCounts> {
  await lockForAssignedImport(repos);
  const snapshot = await repos.dataSnapshot.get(id, now);
  if (!snapshot) throw new NotFoundException('This backup has expired or was deleted, so it can’t be restored.');
  const data = snapshot.data;
  await skipStoredSets(repos, data);
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
  await startNonCycleAtEarliestSet(repos, data);
  await repos.dataSnapshot.delete(id);
  for (const program of programs) {
    if (program !== NON_CYCLE_PROGRAM) await renumberProgram(repos, program);
  }
  return restored;
}
