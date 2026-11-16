// In-memory E2E for Clear data and its snapshots (#1309, proposal decisions 20 to 22): clear and
// restore as a pair, restore beside data stored since, expiry and Delete, and the snapshot's sets
// download. The tables cleared, the failed-save rollback, row-level security and the expiry job
// are proven against Postgres in snapshots.db.e2e.spec.ts.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { LIFT_RECORD_EXPORT_HEADERS, LiftRecord, parseCsvText } from '@lifting-logbook/core';
import type {
  ClearTrainingDataResponse,
  DataSnapshotSummary,
  LiftRecordExportPartsResponse,
  MacrocycleSummaryResponse,
  RestoreSnapshotResponse,
  TrainingDataCounts,
} from '@lifting-logbook/types';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { InMemoryDataSnapshotRepository } from '../adapters/in-memory/data-snapshot.adapter';
import { InMemoryMacrocycleRepository } from '../adapters/in-memory/macrocycle.adapter';
import { AppModule } from '../app.module';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { TRAINING_TABLES, TrainingData } from '../ports/ITrainingDataRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { NON_CYCLE_MACROCYCLE_NUM } from '../programs/non-cycle.util';
import { injectPage } from '../testing/macrocycle-id';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const PROGRAM = '5-3-1';
const DAY_MS = 86_400_000;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Each table's rows, keys and rows in one order, so two reads compare whatever order the stores keep. */
function sorted(data: TrainingData): Record<string, string[]> {
  const canonical = (row: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
  return Object.fromEntries(TRAINING_TABLES.map((t) => [t, data[t].map(canonical).sort()]));
}

/** An exported CSV's rows as objects keyed by header. */
function rowsOf(csv: string): Record<string, string>[] {
  const [header = [], ...rows] = parseCsvText(csv).map((r) => r.map((c) => String(c ?? '')));
  expect(header).toEqual([...LIFT_RECORD_EXPORT_HEADERS]);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

describe('Clear data and snapshots (#1309, e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let nextUser = 0;
  /** Each test acts as its own user, so the in-memory store starts empty. */
  const as = (user = `snapshots-e2e-${++nextUser}`) => {
    const inject = (method: string, url: string, body?: unknown) =>
      injectPage(app, {
        method: method as 'GET',
        url,
        headers:
          body === undefined
            ? { authorization: `Bearer ${user}` }
            : { 'content-type': 'application/json', authorization: `Bearer ${user}` },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const repos = (): Promise<RepositoryBundle> =>
      app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });
    const set = (
      macrocycleNum: number,
      date: string,
      overrides: Pick<Partial<LiftRecord>, 'workoutNum' | 'weight' | 'notes'> = {},
    ): LiftRecord => ({
      program: PROGRAM,
      macrocycleNum,
      workoutNum: 1,
      date: day(date),
      lift: 'squat',
      setNum: 1,
      weight: 200,
      reps: 5,
      notes: '',
      ...overrides,
    });
    const counts = async () => {
      const res = await inject('GET', '/users/me/training-data/counts');
      expect(res.statusCode).toBe(200);
      return res.json<TrainingDataCounts>();
    };
    return {
      user,
      inject,
      repos,
      set,
      counts,
      /** Clears with the counts stored now, as the page does once the lifter confirms them. */
      clear: async () => {
        const res = await inject('POST', '/users/me/training-data/clear', { counts: await counts() });
        expect(res.statusCode).toBe(201);
        return res.json<ClearTrainingDataResponse>().snapshot;
      },
      snapshots: async () => {
        const res = await inject('GET', '/users/me/snapshots');
        expect(res.statusCode).toBe(200);
        return res.json<DataSnapshotSummary[]>();
      },
      restore: (id: string) => inject('POST', `/users/me/snapshots/${id}/restore`),
      list: async (program = PROGRAM) => {
        const res = await inject('GET', `/programs/${program}/macrocycles`);
        expect(res.statusCode).toBe(200);
        return res.json<MacrocycleSummaryResponse[]>();
      },
      initialize: async (macrocycleDate: string, squatMax: number) => {
        const res = await inject('POST', `/programs/${PROGRAM}/macrocycles/initialize`, { macrocycleDate });
        expect(res.statusCode).toBe(201);
        const maxes = await inject('PATCH', `/programs/${PROGRAM}/training-maxes`, {
          maxes: [{ lift: 'Squat', weight: squatMax, unit: 'lbs' }],
        });
        expect(maxes.statusCode).toBe(200);
      },
      log: async (macrocycleNum: number, date: string, workoutNum = 1, weight = 225) => {
        const res = await inject('POST', `/programs/${PROGRAM}/lift-records`, {
          macrocycleNum,
          workoutNum,
          date,
          lift: 'squat',
          setNum: 1,
          weight,
          reps: 5,
        });
        expect(res.statusCode).toBe(201);
      },
      /** An `imported` macrocycle with one set. */
      seedImported: async (macrocycleNum: number, start: string, end: string) => {
        const bundle = await repos();
        (bundle.macrocycle as InMemoryMacrocycleRepository).seed({
          program: PROGRAM,
          macrocycleNum,
          startDate: day(start),
          endDate: day(end),
          status: 'completed',
          statusChosen: false,
          origin: 'imported',
          unmatched: false,
          importedThrough: null,
        });
        await bundle.liftRecord.appendLiftRecords(PROGRAM, [set(macrocycleNum, start, { weight: 999, notes: '=SUM(A1)' })]);
      },
    };
  };

  /**
   * A history with a row in every cleared table: an imported macrocycle, a live one with sets,
   * a schedule and the dashboard, maxes and their history, a modification's own max, each kind of
   * workout override, a focus state and an import batch. Plus setup Clear data keeps.
   */
  const seedEverything = async (u: ReturnType<typeof as>) => {
    await u.seedImported(1, '2025-01-06', '2025-02-17');
    await u.initialize('2025-06-02', 300);
    await u.log(2, '2025-06-02', 1);
    await u.log(2, '2025-06-04', 2);
    const bundle = await u.repos();
    await bundle.trainingMaxHistory.appendHistoryEntries(PROGRAM, [
      { lift: 'squat', weight: 300, reps: 1, date: day('2025-06-01'), isPR: true, source: 'test', goalMet: false },
    ]);
    const modification = await bundle.liftModification.create({ lift: 'squat', name: 'Paused' });
    await bundle.liftModification.saveMaxes(PROGRAM, [{ modificationId: modification.id, weight: 250, dateUpdated: day('2025-06-01') }]);
    await bundle.macrocycleScheduledWorkout.saveScheduledWorkouts(PROGRAM, 2, [
      { workoutNum: 1, weekNum: 1, scheduledDate: day('2025-06-02') },
      { workoutNum: 2, weekNum: 1, scheduledDate: day('2025-06-04') },
    ]);
    await bundle.workoutDateOverride.upsertOverride(PROGRAM, 2, 3, day('2025-06-07'));
    await bundle.workoutSkipOverride.skipWorkout(PROGRAM, 2, 4);
    await bundle.workoutLiftOverride.upsertOverride(PROGRAM, 2, 5, { lift: 'squat', action: 'remove' });
    await bundle.focus.saveDayState(PROGRAM, 2, 1, {
      modes: {},
      picks: {},
      trims: {},
      placement: 'after',
      order: null,
      dismissed: false,
    });
    await bundle.importBatch.save({
      id: 'batch-1',
      userId: u.user,
      program: PROGRAM,
      destination: 'lift-records',
      preImage: { '1:1:2025-01-06:squat:1': { kind: 'created', wrote: { weight: 999 } } },
      createdAt: day('2025-02-18'),
    });
    await bundle.strengthGoal.upsertGoal(PROGRAM, { lift: 'squat', goalType: 'absolute', target: 400, unit: 'lbs', updatedAt: day('2025-06-01') });
    await bundle.trainingMax.dismissMissingMax(PROGRAM, 'bench-press');
    return { modification };
  };

  it('clears every training table, keeps setup, and a restore brings each row back in date order', async () => {
    const u = as();
    const { modification } = await seedEverything(u);
    const before = await (await u.repos()).trainingData.read();
    const counts = await u.counts();
    // The seed reaches every cleared table, so a table the clear or restore misses fails below.
    for (const table of TRAINING_TABLES) expect({ table, rows: counts[table] }).toEqual({ table, rows: expect.any(Number) });
    expect(TRAINING_TABLES.filter((t) => counts[t] === 0)).toEqual([]);

    const snapshot = await u.clear();

    expect(snapshot.counts).toEqual(counts);
    expect(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.createdAt)).toBe(30 * DAY_MS);
    expect(Object.values(await u.counts()).every((n) => n === 0)).toBe(true);
    const bundle = await u.repos();
    expect((await bundle.liftModification.list()).map((m) => m.id)).toEqual([modification.id]);
    expect((await bundle.strengthGoal.getGoals(PROGRAM)).map((g) => g.lift)).toEqual(['squat']);
    expect(await bundle.trainingMax.getMissingMaxDismissals(PROGRAM)).toEqual(['bench-press']);
    expect((await u.snapshots()).map((s) => s.id)).toEqual([snapshot.id]);

    const res = await u.restore(snapshot.id);

    expect(res.statusCode).toBe(200);
    expect(res.json<RestoreSnapshotResponse>().restored).toEqual(counts);
    expect(sorted(await bundle.trainingData.read())).toEqual(sorted(before));
    expect((await u.list()).map((m) => [m.macrocycleNum, m.startDate])).toEqual([
      [1, '2025-01-06'],
      [2, '2025-06-02'],
    ]);
    // A restored snapshot is gone, so it can't be restored twice.
    expect(await u.snapshots()).toEqual([]);
    expect((await u.restore(snapshot.id)).statusCode).toBe(404);
  });

  it('keeps a macrocycle, set, dashboard and max stored since the clear, and brings the old macrocycle back as history', async () => {
    const u = as();
    await u.seedImported(1, '2025-01-06', '2025-02-17');
    await u.initialize('2025-06-02', 300);
    await u.log(2, '2025-06-02', 1);
    await u.log(2, '2025-06-09', 4);
    const snapshot = await u.clear();

    await u.initialize('2026-01-05', 350);
    await u.log(1, '2026-01-05', 1, 275);
    const bundle = await u.repos();
    const dashboardBefore = await bundle.macrocycleDashboard.getMacrocycleDashboard(PROGRAM);
    const newSet = (await bundle.liftRecord.getLiftRecords(PROGRAM, 1))[0];

    expect((await u.restore(snapshot.id)).statusCode).toBe(200);

    const list = await u.list();
    expect(list.map((m) => [m.macrocycleNum, m.startDate, m.origin, m.current])).toEqual([
      [1, '2025-01-06', 'imported', false],
      [2, '2025-06-02', 'live', false],
      [3, '2026-01-05', 'live', true],
    ]);
    // The old current macrocycle ends on its last set, abandoned with most workouts unlogged.
    const closed = (await bundle.macrocycle.list(PROGRAM)).find((m) => m.macrocycleNum === 2);
    expect(closed).toMatchObject({ endDate: day('2025-06-09'), status: 'abandoned' });
    expect(await bundle.macrocycleDashboard.getMacrocycleDashboard(PROGRAM)).toEqual({ ...dashboardBefore, macrocycleNum: 3 });
    expect((await bundle.trainingMax.getTrainingMaxes(PROGRAM)).map((m) => [m.lift, m.weight])).toEqual([['Squat', 350]]);
    expect(await bundle.liftRecord.getLiftRecords(PROGRAM, 3)).toEqual([{ ...newSet, macrocycleNum: 3 }]);
    expect((await bundle.liftRecord.getLiftRecords(PROGRAM, 2)).map((r) => r.date)).toEqual([day('2025-06-02'), day('2025-06-09')]);
    expect((await bundle.liftRecord.getLiftRecords(PROGRAM, 1)).map((r) => r.weight)).toEqual([999]);
  });

  it('gives restored non-cycle workouts numbers past the ones logged since', async () => {
    const u = as();
    const bundle = await u.repos();
    const nonCycle = (workoutNum: number, date: string): LiftRecord => u.set(NON_CYCLE_MACROCYCLE_NUM, date, { workoutNum });
    await bundle.macrocycle.ensure([
      { program: NON_CYCLE_PROGRAM, macrocycleNum: NON_CYCLE_MACROCYCLE_NUM, startDate: day('2025-03-01'), status: 'unknown', origin: 'non-cycle' },
    ]);
    await bundle.liftRecord.appendLiftRecords(NON_CYCLE_PROGRAM, [nonCycle(1, '2025-03-01'), nonCycle(2, '2025-03-08')]);
    const snapshot = await u.clear();
    await bundle.macrocycle.ensure([
      { program: NON_CYCLE_PROGRAM, macrocycleNum: NON_CYCLE_MACROCYCLE_NUM, startDate: day('2026-01-02'), status: 'unknown', origin: 'non-cycle' },
    ]);
    await bundle.liftRecord.appendLiftRecords(NON_CYCLE_PROGRAM, [nonCycle(1, '2026-01-02')]);

    expect((await u.restore(snapshot.id)).statusCode).toBe(200);

    const sets = await bundle.liftRecord.getLiftRecords(NON_CYCLE_PROGRAM, NON_CYCLE_MACROCYCLE_NUM);
    expect(sets.map((r) => [r.workoutNum, r.date]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, day('2026-01-02')],
      [2, day('2025-03-01')],
      [3, day('2025-03-08')],
    ]);
    expect((await bundle.macrocycle.listAll()).filter((m) => m.program === NON_CYCLE_PROGRAM)).toHaveLength(1);
  });

  it('refuses a clear whose confirmed counts no longer match, and changes nothing', async () => {
    const u = as();
    await u.initialize('2025-06-02', 300);
    const counts = await u.counts();
    await u.log(1, '2025-06-02');

    const res = await u.inject('POST', '/users/me/training-data/clear', { counts });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('counts-changed');
    expect((await u.counts()).liftRecords).toBe(1);
    expect(await u.snapshots()).toEqual([]);
  });

  it('clears nothing when the snapshot can’t be saved', async () => {
    const u = as();
    await u.initialize('2025-06-02', 300);
    await u.log(1, '2025-06-02');
    const counts = await u.counts();
    ((await u.repos()).dataSnapshot as InMemoryDataSnapshotRepository).failNextCreate = true;

    const res = await u.inject('POST', '/users/me/training-data/clear', { counts });

    expect(res.statusCode).toBe(503);
    expect(await u.counts()).toEqual(counts);
  });

  it('treats an expired snapshot as gone before the job deletes it, and Delete removes one at once', async () => {
    const u = as();
    await u.initialize('2025-06-02', 300);
    await u.log(1, '2025-06-02');
    const expired = await u.clear();
    ((await u.repos()).dataSnapshot as InMemoryDataSnapshotRepository).setExpiry(expired.id, new Date(Date.now() - 1000));

    expect(await u.snapshots()).toEqual([]);
    expect((await u.restore(expired.id)).statusCode).toBe(404);
    expect((await u.inject('GET', `/users/me/snapshots/${expired.id}/lift-records`)).statusCode).toBe(404);
    expect((await u.inject('GET', `/users/me/snapshots/${expired.id}/lift-records/parts`)).statusCode).toBe(404);
    expect((await u.counts()).liftRecords).toBe(0);

    await u.initialize('2025-08-04', 300);
    const kept = await u.clear();
    expect((await u.inject('DELETE', `/users/me/snapshots/${kept.id}`)).statusCode).toBe(204);
    expect(await u.snapshots()).toEqual([]);
    expect((await u.restore(kept.id)).statusCode).toBe(404);
    expect((await u.inject('DELETE', `/users/me/snapshots/${kept.id}`)).statusCode).toBe(404);
  });

  it('keeps another user’s snapshot out of reach', async () => {
    const owner = as();
    await owner.initialize('2025-06-02', 300);
    const snapshot = await owner.clear();
    const other = as();

    expect(await other.snapshots()).toEqual([]);
    expect((await other.restore(snapshot.id)).statusCode).toBe(404);
    expect((await other.inject('GET', `/users/me/snapshots/${snapshot.id}/lift-records`)).statusCode).toBe(404);
    expect((await other.inject('DELETE', `/users/me/snapshots/${snapshot.id}`)).statusCode).toBe(404);
    expect((await owner.snapshots()).map((s) => s.id)).toEqual([snapshot.id]);
  });

  it('downloads a snapshot’s sets as the same CSV clear offered, formulas escaped', async () => {
    const u = as();
    await u.seedImported(1, '2025-01-06', '2025-02-17');
    await u.initialize('2025-06-02', 300);
    await u.log(2, '2025-06-02');
    const offered = await u.inject('GET', '/users/me/export/lift-records');
    expect(offered.statusCode).toBe(200);
    const snapshot = await u.clear();

    const parts = await u.inject('GET', `/users/me/snapshots/${snapshot.id}/lift-records/parts`);
    expect(parts.statusCode).toBe(200);
    const listing = parts.json<LiftRecordExportPartsResponse>();
    expect(listing).toMatchObject({ rows: 2, parts: [{ part: 1, rows: 2 }] });
    const res = await u.inject('GET', `/users/me/snapshots/${snapshot.id}/lift-records?part=1&split=${listing.split}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const rows = rowsOf(res.body);
    expect(rows).toEqual(rowsOf(offered.body));
    expect(rows.map((r) => r['Notes'])).toContain("'=SUM(A1)");
    expect((await u.inject('GET', `/users/me/snapshots/${snapshot.id}/lift-records?part=2`)).statusCode).toBe(404);
  });
});
