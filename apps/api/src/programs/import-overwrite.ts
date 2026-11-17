import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  ImportPreImage,
  KnownProgram,
  LiftRecordExportRow,
  liftRecordNaturalKey,
  toUTCMidnight,
} from '@lifting-logbook/core';
import {
  ImportOverwriteCounts,
  ImportOverwriteCountsResponse,
  ImportOverwriteScope,
  NON_CYCLE_PROGRAM,
  TrainingDataCounts,
} from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import { OverwriteChanges, ShortenedMacrocycle, StoredSnapshot, StoredSnapshotSummary } from '../ports/IDataSnapshotRepository';
import { ImportBatchRecord, preImageKeyNumber } from '../ports/IImportBatchRepository';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import {
  NUMBERED_TRAINING_TABLES,
  TRAINING_TABLES,
  TrainingData,
  TrainingRow,
  liftRecordRows,
  macrocycleRows,
} from '../ports/ITrainingDataRepository';
import {
  SNAPSHOT_RETENTION_DAYS,
  closeReplacedCurrent,
  countRows,
  isLiftRecordsBatch,
  leaveOutSets,
  placeAfterStored,
  placeNonCycleAfterStored,
  programsIn,
  skipStoredSets,
  startNonCycleAtEarliestSet,
} from '../snapshots/training-data.service';
import { recomputeMacrocycles } from './import-stored';
import { NON_CYCLE_ROW_KEY, dashboardOrNull, weekdayOf } from './macrocycle-history.util';
import { renumberProgram } from './macrocycle-renumbering';
import { NON_CYCLE_MACROCYCLE_NUM } from './non-cycle.util';

/**
 * Overwriting stored history with a fresh import (#1182, proposal decision 19). The lifter picks
 * a scope at Assign and confirms what it removes. The commit saves what it removes and changes in
 * an `overwrite` snapshot, then removes it, then writes the file as any import does, all in one
 * transaction. Undoing the import removes its rows and restores the snapshot.
 */

type Repos = Pick<
  RepositoryBundle,
  | 'trainingData'
  | 'dataSnapshot'
  | 'macrocycle'
  | 'macrocycleDashboard'
  | 'importBatch'
  | 'liftRecord'
  | 'liftingProgramSpec'
>;

const DAY_MS = 24 * 60 * 60 * 1000;

type SetRow = LiftRecordExportRow & TrainingRow;
type MacrocycleTrainingRow = MacrocycleRow & TrainingRow;

/** What an overwrite removes and changes, worked out from the stored rows before anything is written. */
export interface OverwritePlan {
  /** Every removed row, by table, and the batch keys dropped (each batch with only those keys). */
  removed: TrainingData;
  /** The macrocycle numbers removed whole, with every row on them, by program. */
  removedNums: Map<string, number[]>;
  /** The natural keys of sets removed from macrocycles and non-cycle workouts that stay, by program. */
  removedSetKeys: Map<string, string[]>;
  /** Macrocycles that keep sets, with the dates they're left with. */
  shortened: Array<Omit<ShortenedMacrocycle, 'status'>>;
  /** Current macrocycles whose start a range cut: the dashboard's date before and after. */
  dashboards: OverwriteChanges['dashboards'];
  /** Each lift-records batch's pre-image without the keys naming what's removed. */
  batchUpdates: Array<{ id: string; preImage: ImportPreImage }>;
  counts: ImportOverwriteCounts;
}

const cycleKey = (program: string, macrocycleNum: number | undefined) => `${program}|${macrocycleNum}`;

function dayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getTime();
}

function emptyData(): TrainingData {
  return Object.fromEntries(TRAINING_TABLES.map((table) => [table, []])) as unknown as TrainingData;
}

function groupBy<T, V>(items: Iterable<T>, key: (item: T) => string, value: (item: T) => V) {
  const groups = new Map<string, V[]>();
  for (const item of items) {
    const list = groups.get(key(item)) ?? [];
    list.push(value(item));
    groups.set(key(item), list);
  }
  return groups;
}

/** A lift-records batch's pre-image, as the import stored it. */
const preImageOf = (batch: TrainingRow) => batch['preImage'] as ImportPreImage;

/**
 * What `scope` removes from `data` (#1182, decision 19), without writing anything.
 *
 * - `all`: every row of every table that holds a macrocycle number, in every program, the
 *   non-cycle workouts included.
 * - `imported`: `imported` macrocycles with every row on them, and the non-cycle sets an import
 *   created, which its batch keys name.
 * - `range`: every set dated inside it. A macrocycle left with no sets goes with every row on it,
 *   as does one with no sets at all that lies wholly inside the range. One that keeps sets is
 *   shortened: a start inside the range moves to its first set left and an end inside it to its
 *   last, and a current one's dashboard date moves with its start.
 *
 * Every lift-records batch drops the keys naming what's removed, so undoing an older import can't
 * delete a set this one writes in its place.
 */
export function planOverwrite(data: TrainingData, scope: ImportOverwriteScope): OverwritePlan {
  const sets: SetRow[] = liftRecordRows(data);
  const macrocycles: MacrocycleTrainingRow[] = macrocycleRows(data);
  const removedCycles = new Set<string>();
  const removedSets = new Set<SetRow>();
  const shortened: OverwritePlan['shortened'] = [];

  if (scope.kind === 'all') {
    for (const table of NUMBERED_TRAINING_TABLES) {
      for (const row of data[table]) removedCycles.add(cycleKey(row.program, row.macrocycleNum));
    }
  } else if (scope.kind === 'imported') {
    for (const m of macrocycles) if (m.origin === 'imported') removedCycles.add(cycleKey(m.program, m.macrocycleNum));
    const importedNonCycle = new Set(
      data.importBatches.filter(isLiftRecordsBatch).flatMap((batch) =>
        Object.entries(preImageOf(batch))
          .filter(([key, entry]) => key.startsWith(NON_CYCLE_ROW_KEY) && entry.kind === 'created')
          .map(([key]) => key.slice(NON_CYCLE_ROW_KEY.length)),
      ),
    );
    for (const r of sets) if (r.program === NON_CYCLE_PROGRAM && importedNonCycle.has(liftRecordNaturalKey(r))) removedSets.add(r);
  } else {
    const from = dayOf(scope.from);
    const to = dayOf(scope.to);
    const inRange = (date: Date) => {
      const t = toUTCMidnight(date).getTime();
      return t >= from && t <= to;
    };
    const left = new Map<string, SetRow[]>();
    const lost = new Set<string>();
    for (const r of sets) {
      const key = cycleKey(r.program, r.macrocycleNum);
      if (inRange(r.date)) {
        removedSets.add(r);
        lost.add(key);
      } else {
        const kept = left.get(key) ?? [];
        kept.push(r);
        left.set(key, kept);
      }
    }
    for (const m of macrocycles) {
      // The non-cycle macrocycle stays, as it does when its workouts are deleted.
      if (m.program === NON_CYCLE_PROGRAM) continue;
      const key = cycleKey(m.program, m.macrocycleNum);
      const kept = left.get(key) ?? [];
      if (kept.length === 0 && (lost.has(key) || (inRange(m.startDate) && inRange(m.endDate ?? m.startDate)))) {
        removedCycles.add(key);
      } else if (lost.has(key)) {
        const times = kept.map((r) => toUTCMidnight(r.date).getTime());
        shortened.push({
          before: m,
          startDate: inRange(m.startDate) ? new Date(Math.min(...times)) : m.startDate,
          endDate: m.endDate && inRange(m.endDate) ? new Date(Math.max(...times)) : m.endDate,
        });
      }
    }
  }

  const removed = emptyData();
  for (const table of NUMBERED_TRAINING_TABLES) {
    removed[table] = data[table].filter((row) => removedCycles.has(cycleKey(row.program, row.macrocycleNum)));
  }
  // Sets left on a macrocycle that stays, or on the non-cycle workouts.
  const loose = [...removedSets].filter((r) => !removedCycles.has(cycleKey(r.program, r.macrocycleNum)));
  removed.liftRecords.push(...loose);
  const removedNums = groupBy(
    removedCycles,
    (key) => key.slice(0, key.lastIndexOf('|')),
    (key) => Number(key.slice(key.lastIndexOf('|') + 1)),
  );
  const removedSetKeys = groupBy(loose, (r) => r.program, (r) => liftRecordNaturalKey(r));

  const dashboards: OverwritePlan['dashboards'] = [];
  for (const s of shortened) {
    if (s.startDate.getTime() === s.before.startDate.getTime()) continue;
    const dashboard = data.macrocycleDashboards.find(
      (d) => d.program === s.before.program && d.macrocycleNum === s.before.macrocycleNum,
    );
    if (!dashboard) continue;
    dashboards.push({
      program: s.before.program,
      macrocycleId: s.before.id,
      macrocycleDate: dashboard['macrocycleDate'] as Date,
      macrocycleStartWeekday: dashboard['macrocycleStartWeekday'] as OverwriteChanges['dashboards'][number]['macrocycleStartWeekday'],
      to: s.startDate,
    });
  }

  const removedKeys = new Map([...removedSetKeys].map(([program, keys]) => [program, new Set(keys)]));
  const batchUpdates: OverwritePlan['batchUpdates'] = [];
  for (const batch of data.importBatches) {
    if (!isLiftRecordsBatch(batch)) continue;
    const drops = ([key]: [string, unknown]): boolean => {
      if (key.startsWith(NON_CYCLE_ROW_KEY)) {
        return scope.kind === 'all' || removedKeys.get(NON_CYCLE_PROGRAM)?.has(key.slice(NON_CYCLE_ROW_KEY.length)) === true;
      }
      const num = preImageKeyNumber(key);
      // A training max a 1RM split wrote: overwrite leaves maxes alone.
      if (num === null) return false;
      return (
        scope.kind === 'all' || removedCycles.has(cycleKey(batch.program, num)) || removedKeys.get(batch.program)?.has(key) === true
      );
    };
    const entries = Object.entries(preImageOf(batch));
    const dropped = entries.filter(drops);
    if (dropped.length === 0) continue;
    removed.importBatches.push({ ...batch, preImage: Object.fromEntries(dropped) });
    batchUpdates.push({ id: String(batch['id']), preImage: Object.fromEntries(entries.filter((e) => !drops(e))) });
  }

  return {
    removed,
    removedNums,
    removedSetKeys,
    shortened,
    dashboards,
    batchUpdates,
    counts: {
      sets: removed.liftRecords.length,
      // The non-cycle workouts' shared macrocycle is no macrocycle to the lifter.
      macrocycles: removed.macrocycles.filter((m) => m.program !== NON_CYCLE_PROGRAM).length,
      current: removed.macrocycleDashboards.length,
      shortened: shortened.length,
    },
  };
}

/** What each scope would remove, for Assign (#1182, decision 16). */
export async function overwriteCounts(
  repos: Pick<RepositoryBundle, 'trainingData'>,
  range?: { from: string; to: string },
): Promise<ImportOverwriteCountsResponse> {
  const data = await repos.trainingData.read();
  return {
    all: planOverwrite(data, { kind: 'all' }).counts,
    imported: planOverwrite(data, { kind: 'imported' }).counts,
    ...(range ? { range: planOverwrite(data, { kind: 'range', ...range }).counts } : {}),
  };
}

/** A `YYYY-MM-DD` day that exists, as the breakdown's dates are checked. */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** A date range's ends, checked: both days, `from` no later than `to`. */
export function parseOverwriteRange(from: unknown, to: unknown): { from: string; to: string } {
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new BadRequestException('A date range needs from and to as YYYY-MM-DD dates');
  if (from > to) throw new BadRequestException('A date range’s from must not be after its to');
  return { from, to };
}

const COUNT_FIELDS: ReadonlyArray<keyof ImportOverwriteCounts> = ['sets', 'macrocycles', 'current', 'shortened'];

/** The 503's code when the backup can't be saved, so the wizard shows its message. */
const OVERWRITE_BACKUP_FAILED = 'overwrite-backup-failed';

/** A breakdown's `overwrite`, checked for shape, or undefined with none. */
export function parseOverwrite(value: unknown): { scope: ImportOverwriteScope; counts: ImportOverwriteCounts } | undefined {
  if (value === undefined) return undefined;
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.counts)) {
    throw new BadRequestException('breakdown.overwrite must have a scope and the confirmed counts');
  }
  const { kind } = value.scope;
  let scope: ImportOverwriteScope;
  if (kind === 'all' || kind === 'imported') scope = { kind };
  else if (kind === 'range') scope = { kind, ...parseOverwriteRange(value.scope.from, value.scope.to) };
  else throw new BadRequestException('breakdown.overwrite.scope.kind must be all, imported or range');
  const { sets, macrocycles, current, shortened } = value.counts;
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (!isCount(sets) || !isCount(macrocycles) || !isCount(current) || !isCount(shortened)) {
    throw new BadRequestException(`breakdown.overwrite.counts must give ${COUNT_FIELDS.join(', ')} as whole numbers`);
  }
  return { scope, counts: { sets, macrocycles, current, shortened } };
}

/**
 * Removes what `plan` removes and shortens what it shortens, then renumbers each program it
 * touched (decision 3). An `imported` macrocycle a range shortened reads its status again from
 * the sets it keeps, as undo reads one again (#1255).
 */
async function applyOverwrite(
  repos: Repos,
  plan: OverwritePlan,
  context: { programs: readonly KnownProgram[]; asOf: Date },
): Promise<void> {
  for (const [program, nums] of plan.removedNums) await repos.macrocycle.delete(program, nums);
  for (const [program, keys] of plan.removedSetKeys) await repos.liftRecord.deleteLiftRecordsByNaturalKeys(program, keys);
  for (const s of plan.shortened) await repos.macrocycle.update(s.before.id, { startDate: s.startDate, endDate: s.endDate });
  for (const d of plan.dashboards) {
    const dashboard = await repos.macrocycleDashboard.getMacrocycleDashboard(d.program);
    await repos.macrocycleDashboard.saveMacrocycleDashboard({ ...dashboard, macrocycleDate: d.to, macrocycleStartWeekday: weekdayOf(d.to) });
  }
  await repos.importBatch.updatePreImages(plan.batchUpdates);
  await recomputeMacrocycles(
    repos,
    plan.shortened.filter((s) => s.before.origin === 'imported').map((s) => s.before.id),
    context.programs,
    context.asOf,
  );
  for (const program of touchedPrograms(plan)) await renumberProgram(repos, program);
}

function touchedPrograms(plan: OverwritePlan): string[] {
  return [...new Set([...plan.removedNums.keys(), ...plan.shortened.map((s) => s.before.program)])]
    .filter((p) => p !== NON_CYCLE_PROGRAM)
    .sort();
}

function hasChanges(plan: OverwritePlan): boolean {
  return TRAINING_TABLES.some((table) => plan.removed[table].length > 0) || plan.shortened.length > 0;
}

/**
 * Replaces stored history for an import (#1182), in the caller's transaction, which holds the
 * import lock. Reads what's stored, and when the scope's counts differ from `confirmed`, changes
 * nothing and is a 409. Otherwise it removes and changes what the scope holds, then, unless
 * `dryRun`, saves a snapshot of it, with what the shortened macrocycles were left with. When the
 * snapshot can't be saved it's a 503, and the request transaction rolls the removal back, so
 * nothing is replaced without a backup. Returns the snapshot, or null when the scope holds nothing
 * or this is a dry run.
 */
export async function replaceStoredHistory(
  repos: Repos,
  overwrite: { scope: ImportOverwriteScope; counts: ImportOverwriteCounts },
  context: { programs: readonly KnownProgram[]; asOf: Date; now: Date; dryRun: boolean },
): Promise<{ snapshot: StoredSnapshotSummary | null; counts: ImportOverwriteCounts }> {
  const plan = planOverwrite(await repos.trainingData.read(), overwrite.scope);
  if (COUNT_FIELDS.some((field) => plan.counts[field] !== overwrite.counts[field])) {
    throw new ConflictException({
      statusCode: 409,
      code: 'overwrite-counts-changed',
      message:
        'Your stored history has changed since you confirmed what to replace, so nothing was imported. Check the counts and confirm again.',
      error: 'Conflict',
      counts: plan.counts,
    });
  }
  if (!hasChanges(plan)) return { snapshot: null, counts: plan.counts };
  await applyOverwrite(repos, plan, context);
  let snapshot: StoredSnapshotSummary | null = null;
  if (!context.dryRun) {
    // What each shortened macrocycle was left with, read once the overwrite has read its status
    // again, so undo can tell whether it changed since.
    const after = new Map((await repos.macrocycle.listAll()).map((m) => [m.id, m]));
    const shortened = plan.shortened.map((s) => {
      const m = after.get(s.before.id);
      return m ? { ...s, startDate: m.startDate, endDate: m.endDate, status: m.status } : { ...s, status: s.before.status };
    });
    try {
      snapshot = await repos.dataSnapshot.create({
        kind: 'overwrite',
        scope: {
          programs: [...new Set([...programsIn(plan.removed), ...plan.shortened.map((s) => s.before.program)])].sort(),
          overwrite: overwrite.scope,
        },
        counts: countRows(plan.removed),
        data: plan.removed,
        overwrite: {
          macrocycles: shortened,
          dashboards: plan.dashboards,
        },
        createdAt: context.now,
        expiresAt: new Date(context.now.getTime() + SNAPSHOT_RETENTION_DAYS * DAY_MS),
      });
    } catch (err) {
      throw new ServiceUnavailableException(
        {
          statusCode: 503,
          code: OVERWRITE_BACKUP_FAILED,
          message: 'Your history couldn’t be backed up, so nothing was replaced or imported. Please try again in a moment.',
          error: 'Service Unavailable',
        },
        { cause: err },
      );
    }
  }
  return { snapshot, counts: plan.counts };
}

/** Why undoing an overwrite is refused (#1182). Names no row, so it can be logged. */
export type OverwriteUndoRefusal = 'backup-gone' | 'later-overwrite';

/** Undoing an overwrite was refused, and nothing changed. */
export class OverwriteUndoRefusedException extends ConflictException {
  constructor(
    readonly reason: OverwriteUndoRefusal,
    message: string,
  ) {
    super({ statusCode: 409, code: `overwrite-undo-${reason}`, reason, message, error: 'Conflict' });
  }
}

/**
 * The snapshot undoing an overwrite batch restores, checked before anything changes (#1182,
 * decision 19). Undo is refused while a later overwrite's batch exists that can still be undone,
 * so overwrites undo newest first. A later one whose backup is gone can never be undone, so it
 * doesn't hold this one back. Undo is refused too once this one's snapshot has expired or been
 * deleted: undoing would then remove the imported rows and restore nothing.
 */
export async function overwriteToUndo(
  repos: Pick<RepositoryBundle, 'importBatch' | 'dataSnapshot'>,
  batch: Pick<ImportBatchRecord, 'id' | 'createdAt'>,
  snapshotId: string,
  now: Date,
): Promise<StoredSnapshot> {
  const later = (await repos.importBatch.listOverwrites()).filter(
    (b) =>
      b.id !== batch.id &&
      (b.createdAt.getTime() > batch.createdAt.getTime() || (b.createdAt.getTime() === batch.createdAt.getTime() && b.id > batch.id)),
  );
  const backups = later.length > 0 ? new Set((await repos.dataSnapshot.list(now)).filter((s) => s.kind === 'overwrite').map((s) => s.id)) : new Set();
  if (later.some((b) => backups.has(b.snapshotId))) {
    throw new OverwriteUndoRefusedException(
      'later-overwrite',
      'A later import replaced your history too. Undo that import first, then this one.',
    );
  }
  const snapshot = snapshotId ? await repos.dataSnapshot.get(snapshotId, now) : null;
  if (!snapshot || snapshot.kind !== 'overwrite') {
    throw new OverwriteUndoRefusedException(
      'backup-gone',
      'The backup of the history this import replaced has expired or was deleted, so undoing it would remove the imported history and put nothing back. It can’t be undone.',
    );
  }
  return snapshot;
}

/**
 * When a restored non-cycle workout's number now holds another workout, logged since on another
 * day, the restored ones move past every logged number, as a restore does. Otherwise they keep
 * their numbers, so an undo puts them back as they were.
 */
async function placeNonCycleWorkouts(repos: Repos, data: TrainingData): Promise<void> {
  const restoring = new Map<number, Set<number>>();
  for (const r of liftRecordRows(data)) {
    if (r.program !== NON_CYCLE_PROGRAM) continue;
    const days = restoring.get(r.workoutNum) ?? new Set<number>();
    days.add(toUTCMidnight(r.date).getTime());
    restoring.set(r.workoutNum, days);
  }
  if (restoring.size === 0) return;
  const stored = await repos.liftRecord.getLiftRecords(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
  const taken = stored.some((r) => {
    const days = restoring.get(r.workoutNum);
    return days !== undefined && !days.has(toUTCMidnight(r.date).getTime());
  });
  if (taken) await placeNonCycleAfterStored(repos, data);
}

/**
 * The sets in `data` that a batch undone since the overwrite created: the overwrite removed them
 * and kept that batch's keys for them, and the batch can't take them back now.
 */
function setsOfUndoneBatches(data: TrainingData, undone: readonly TrainingRow[]): Set<TrainingRow> {
  const keys = new Set(
    undone.flatMap((batch) =>
      Object.keys(preImageOf(batch)).map((key) =>
        key.startsWith(NON_CYCLE_ROW_KEY) ? `${NON_CYCLE_PROGRAM}|${key.slice(NON_CYCLE_ROW_KEY.length)}` : `${batch.program}|${key}`,
      ),
    ),
  );
  return new Set(liftRecordRows(data).filter((r) => keys.has(`${r.program}|${liftRecordNaturalKey(r)}`)));
}

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * Puts back what an overwrite removed and changed (#1182), after its import's own rows are
 * undone, then deletes the snapshot, in the caller's transaction. A set stored again since isn't
 * restored twice, as in a restore (ADR-044), and a set a batch undone since created stays undone.
 * A shortened macrocycle that still exists keeps its current number and its sets go back onto
 * it; the removed macrocycles go past every stored number. A shortened `imported` macrocycle's
 * dates are read again from its sets, as the overwrite read them; another keeps any date changed
 * since, and gets back each date the overwrite moved. An `imported` one gets back its status while
 * it still has the one the overwrite left; the overwrite changes no other's. A current macrocycle's dashboard
 * date goes back while the dashboard still points at it. The batch keys the overwrite dropped go
 * back to the batches still stored. Then each program is renumbered by start date. Returns the
 * rows inserted.
 */
export async function restoreOverwrite(
  repos: Repos,
  snapshot: StoredSnapshot,
  context: { programs: readonly KnownProgram[]; asOf: Date },
): Promise<TrainingDataCounts> {
  const data = snapshot.data;
  const changes: OverwriteChanges = snapshot.overwrite ?? { macrocycles: [], dashboards: [] };
  const fragmentIds = data.importBatches.map((f) => String(f['id']));
  const storedBatches = new Map((await repos.importBatch.listByIds(fragmentIds)).map((b) => [b.id, b]));
  const undone = data.importBatches.filter((f) => !storedBatches.has(String(f['id'])));
  await leaveOutSets(repos, data, setsOfUndoneBatches(data, undone));
  data.importBatches = data.importBatches.filter((f) => storedBatches.has(String(f['id'])));
  await skipStoredSets(repos, data);

  const byId = new Map((await repos.macrocycle.listAll()).map((m) => [m.id, m]));
  const kept = new Map<string, { change: ShortenedMacrocycle; now: MacrocycleRow }>();
  for (const change of changes.macrocycles) {
    const now = byId.get(change.before.id);
    if (now && now.program === change.before.program) kept.set(now.id, { change, now });
    // Deleted since, so it comes back as a removed one.
    else data.macrocycles.push(change.before);
  }
  const programs = [...new Set([...programsIn(data), ...changes.macrocycles.map((m) => m.before.program)])].sort();
  for (const program of programs) {
    if (program === NON_CYCLE_PROGRAM) {
      await placeNonCycleWorkouts(repos, data);
      continue;
    }
    const onKept = new Map(
      [...kept.values()]
        .filter(({ now }) => now.program === program)
        .map(({ change, now }) => [change.before.macrocycleNum, now.macrocycleNum] as const),
    );
    await placeAfterStored(repos, data, program, onKept);
    await closeReplacedCurrent(repos, data, program);
  }

  const fragments = data.importBatches;
  const restored = await repos.trainingData.insertMissing({ ...data, importBatches: [] });
  const imported = [...kept.values()].filter(({ now }) => now.origin === 'imported');
  for (const { change, now } of kept.values()) {
    if (now.origin === 'imported') continue;
    const { before } = change;
    const startDate = !sameTime(change.startDate, before.startDate) && sameTime(now.startDate, change.startDate) ? before.startDate : now.startDate;
    const endDate = !sameTime(change.endDate, before.endDate) && sameTime(now.endDate, change.endDate) ? before.endDate : now.endDate;
    if (!sameTime(startDate, now.startDate) || !sameTime(endDate, now.endDate)) await repos.macrocycle.update(now.id, { startDate, endDate });
  }
  await recomputeMacrocycles(
    repos,
    imported.map(({ now }) => now.id),
    context.programs,
    context.asOf,
  );
  // The dates come from the sets, but the status goes back to the one before the overwrite while
  // it's still the one the overwrite left; a status set since, by a choice or a close, stays.
  for (const { change, now } of imported) {
    const unchanged = now.status === change.status && now.statusChosen === change.before.statusChosen;
    await repos.macrocycle.update(now.id, { status: unchanged ? change.before.status : now.status });
  }
  for (const d of changes.dashboards) {
    const dashboard = await dashboardOrNull(repos, d.program);
    const macrocycle = kept.get(d.macrocycleId)?.now;
    // Left alone once it points elsewhere or its date was changed since.
    if (!dashboard || !macrocycle || dashboard.macrocycleNum !== macrocycle.macrocycleNum || !sameTime(dashboard.macrocycleDate, d.to)) continue;
    await repos.macrocycleDashboard.saveMacrocycleDashboard({
      ...dashboard,
      macrocycleDate: d.macrocycleDate,
      macrocycleStartWeekday: d.macrocycleStartWeekday,
    });
  }
  await startNonCycleAtEarliestSet(repos, data);
  const updates = [];
  for (const fragment of fragments) {
    const batch = storedBatches.get(String(fragment['id']));
    if (batch) updates.push({ id: batch.id, preImage: { ...batch.preImage, ...preImageOf(fragment) } });
  }
  await repos.importBatch.updatePreImages(updates);
  restored.importBatches = updates.length;
  await repos.dataSnapshot.delete(snapshot.id);
  for (const program of programs) if (program !== NON_CYCLE_PROGRAM) await renumberProgram(repos, program);
  return restored;
}
