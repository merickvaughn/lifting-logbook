import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import type {
  DataSnapshotSummary,
  ImportAssignResponse,
  ImportBreakdown,
  ImportBreakdownStretch,
  ImportCommitResponse,
  ImportDryRunResponse,
  ImportOverwriteCounts,
  ImportOverwriteCountsResponse,
  ImportOverwriteRangeCountsResponse,
  ImportOverwriteScope,
  MacrocycleDashboardResponse,
} from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { InMemoryDataSnapshotRepository } from '../adapters/in-memory/data-snapshot.adapter';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { TRAINING_TABLES, TrainingData } from '../ports/ITrainingDataRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { injectPage } from '../testing/macrocycle-id';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';

/**
 * In-memory E2E for overwriting stored history with a fresh import (#1182, proposal decision 19):
 * each scope's counts and what it removes, the confirmation, the dry run, undo, and undo's
 * refusals. The failed backup runs against Postgres in `import-overwrite.db.e2e.spec.ts`.
 */
describe('Import: overwrite stored history (#1182, e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;
  const FLAG = 'IMPORT_ASSIGN_ENABLED';
  const savedFlag = process.env[FLAG];

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  // Each test is its own user, so the in-memory store starts empty.
  let user = 'import-overwrite-e2e-0';
  let nextUser = 0;
  beforeEach(async () => {
    user = `import-overwrite-e2e-${++nextUser}`;
    process.env[FLAG] = 'true';
    await (await repos()).userSettings.upsertSettings({ workoutSchedule: { type: 'fixed', days: [0, 1, 2, 3, 4, 5, 6] } });
  });
  const auth = () => ({ authorization: `Bearer ${user}` });
  const repos = (): Promise<RepositoryBundle> =>
    app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });
  const server = () => app.getHttpAdapter().getInstance();

  const DAY_MS = 86_400_000;
  const TODAY = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const ymd = (date: Date) => date.toISOString().slice(0, 10);
  /** `n` days from today: negative is past. */
  const day = (n: number) => ymd(new Date(TODAY + n * DAY_MS));
  const utc = (n: number) => new Date(`${day(n)}T00:00:00Z`);

  const importCsv = (csv: string, query: string, fields: Record<string, string> = {}) => {
    const boundary = '----OverwriteBoundary';
    const parts = [
      ...Object.entries({ today: day(0), ...fields }).flatMap(([name, value]) => [
        `--${boundary}`,
        `Content-Disposition: form-data; name="${name}"`,
        '',
        value,
      ]),
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="upload.csv"',
      'Content-Type: text/csv',
      '',
      csv,
      `--${boundary}--`,
    ];
    return server().inject({
      method: 'POST',
      url: `/programs/rpt/import${query}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...auth() },
      payload: parts.join('\r\n'),
    });
  };

  const page = (method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    injectPage(app, {
      method,
      url,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...auth() },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const RPT_DAYS = [
    ['Bench Press', 'Barbell Row', 'Overhead Press'],
    ['Squat', 'Romanian Deadlift', 'Calf Raises'],
    ['Deadlift', 'Weighted Pull-ups', 'Dips'],
  ];

  interface Row {
    day: number;
    lift: string;
    weight?: number;
    program?: string;
  }

  /** `count` RPT sessions of three sets, every other day from `start`. */
  const run = (start: number, count: number, weight = 100): Row[] =>
    Array.from({ length: count }, (_, i) => (RPT_DAYS[i % 3] ?? []).map((lift) => ({ day: start + i * 2, lift, weight }))).flat();

  const csvOf = (rows: Row[]) => {
    const withProgram = rows.some((r) => r.program !== undefined);
    return [
      `${withProgram ? 'Program,' : ''}Date,Lift,Set #,Weight,Reps,Notes`,
      ...rows.map((r) => [...(withProgram ? [r.program ?? ''] : []), day(r.day), r.lift, 1, r.weight ?? 100, 8, ''].join(',')),
    ].join('\n');
  };

  /** Every cycle row in one stretch per run of `runs`. */
  const breakdownOf = (runs: Row[][], overwrite?: ImportBreakdown['overwrite']): ImportBreakdown => ({
    stretches: runs.map(
      (rows): ImportBreakdownStretch => ({
        program: 'rpt',
        dates: [...new Set(rows.filter((r) => r.program !== NON_CYCLE_PROGRAM).map((r) => r.day))].sort((a, b) => a - b).map(day),
        status: 'completed',
        statusChosen: false,
      }),
    ),
    excludedDates: [],
    nonCycleDates: [],
    ...(overwrite ? { overwrite } : {}),
  });

  const assign = async (rows: Row[]) => {
    const res = await importCsv(csvOf(rows), '?mode=assign&destination=lift-records');
    expect(res.statusCode).toBe(200);
    return res.json<ImportAssignResponse>();
  };

  const send = (runs: Row[][], overwrite?: ImportBreakdown['overwrite'], mode: 'commit' | 'dry-run' = 'commit') =>
    importCsv(csvOf(runs.flat()), `?mode=${mode}&destination=lift-records`, {
      breakdown: JSON.stringify(breakdownOf(runs, overwrite)),
    });

  const commit = async (runs: Row[][], overwrite?: ImportBreakdown['overwrite']) => {
    const res = await send(runs, overwrite);
    expect(res.statusCode).toBe(200);
    return res.json<ImportCommitResponse>();
  };

  const rangeCounts = async (from: number, to: number) => {
    const res = await server().inject({
      method: 'GET',
      url: `/programs/rpt/import/overwrite-counts?from=${day(from)}&to=${day(to)}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    return res.json<ImportOverwriteRangeCountsResponse>();
  };

  /** What all and all imported history would remove, as Assign reads them when Replace is picked. */
  const scopeCounts = async () => {
    const res = await server().inject({ method: 'GET', url: '/programs/rpt/import/overwrite-counts', headers: auth() });
    expect(res.statusCode).toBe(200);
    return res.json<ImportOverwriteCountsResponse>();
  };

  /** Overwrites `scope` with `runs`, confirming the counts the counts route gives. */
  const overwrite = async (runs: Row[][], scope: ImportOverwriteScope) => {
    const counts = await countsFor(scope);
    return commit(runs, { scope, counts });
  };

  const countsFor = async (scope: ImportOverwriteScope): Promise<ImportOverwriteCounts> => {
    if (scope.kind !== 'range') return (await scopeCounts())[scope.kind];
    const res = await server().inject({
      method: 'GET',
      url: `/programs/rpt/import/overwrite-counts?from=${scope.from}&to=${scope.to}`,
      headers: auth(),
    });
    return res.json<ImportOverwriteRangeCountsResponse>().range;
  };

  const undoRequest = (batchId: string | null) =>
    server().inject({ method: 'POST', url: `/programs/rpt/import/${batchId}/undo`, headers: auth() });

  const undo = async (batchId: string | null) => {
    const res = await undoRequest(batchId);
    expect(res.statusCode).toBe(200);
  };

  const snapshots = async () => {
    const res = await server().inject({ method: 'GET', url: '/users/me/snapshots', headers: auth() });
    return res.json<DataSnapshotSummary[]>();
  };

  const current = async () => {
    const res = await server().inject({ method: 'GET', url: '/programs/rpt/macrocycles/current', headers: auth() });
    return res.statusCode === 200 ? res.json<MacrocycleDashboardResponse>() : null;
  };

  const macrocycles = async () => (await repos()).macrocycle.list('rpt');
  const sets = async (program = 'rpt') => (await (await repos()).trainingData.read()).liftRecords.filter((r) => r.program === program);

  /** A row as JSON with its keys sorted, so two rows alike compare alike whatever order their keys went in. */
  const canonical = (row: object) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))));

  /** Every stored training row, each table sorted, so two reads compare whatever order the rows went in. */
  const state = async (): Promise<TrainingData> => {
    const data = await (await repos()).trainingData.read();
    for (const table of TRAINING_TABLES) data[table] = [...data[table]].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
    return data;
  };

  /** Starts a live RPT macrocycle on `start`, with a set on workout 1, workout 2 skipped and 3 moved. */
  const liveWithOverrides = async (start: number) => {
    expect((await page('POST', '/programs/rpt/macrocycles/initialize', { macrocycleDate: day(start) })).statusCode).toBe(201);
    const live = (await macrocycles()).find((m) => m.origin === 'live');
    if (!live) throw new Error('no live macrocycle');
    const n = live.macrocycleNum;
    const set = { lift: 'Bench Press', setNum: 1, weight: 135, reps: 5, macrocycleNum: n, workoutNum: 1, date: day(start) };
    expect((await page('POST', '/programs/rpt/lift-records', set)).statusCode).toBe(201);
    expect((await page('POST', `/programs/rpt/macrocycles/${n}/workouts/2/skip`, {})).statusCode).toBe(204);
    expect((await page('PATCH', `/programs/rpt/macrocycles/${n}/workouts/3/reschedule`, { newDate: day(start + 9) })).statusCode).toBe(204);
    return live;
  };

  /** Logs one more set on the live macrocycle, on workout `workoutNum` and day `n`. */
  const logOn = async (macrocycleNum: number, workoutNum: number, n: number) => {
    const set = { lift: 'Squat', setNum: 1, weight: 185, reps: 5, macrocycleNum, workoutNum, date: day(n) };
    expect((await page('POST', '/programs/rpt/lift-records', set)).statusCode).toBe(201);
  };

  const handNonCycle = async (n: number) => {
    const res = await page('POST', '/non-cycle-workouts', { date: day(n), lift: 'Bench Press', setNum: 1, weight: 95, reps: 10 });
    expect(res.statusCode).toBe(201);
  };

  /** The program's macrocycle numbers in start-date order are 1 to N. */
  const expectDenseInDateOrder = async () => {
    const rows = await macrocycles();
    expect(rows.map((m) => m.macrocycleNum)).toEqual(rows.map((_, i) => i + 1));
    const starts = rows.map((m) => m.startDate.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  };

  const OLD = run(-200, 6);
  const NEW = run(-150, 6, 200);

  describe('all history', () => {
    it('removes every set and macrocycle, current ones with their schedule and overrides, and non-cycle workouts', async () => {
      await commit([OLD]);
      const live = await liveWithOverrides(-30);
      await handNonCycle(-100);
      const bundle = await repos();
      expect(await bundle.macrocycleScheduledWorkout.getScheduledWorkouts('rpt', live.macrocycleNum)).not.toHaveLength(0);

      const counts = (await scopeCounts()).all;
      expect(counts).toEqual({ sets: OLD.length + 2, macrocycles: 2, current: 1, shortened: 0 });
      const body = await commit([NEW], { scope: { kind: 'all' }, counts });
      expect(body.created).toBe(NEW.length);

      const rows = await macrocycles();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ origin: 'imported', macrocycleNum: 1, startDate: utc(-150) });
      expect((await sets()).map((r) => r.weight)).toEqual(NEW.map(() => 200));
      expect(await sets(NON_CYCLE_PROGRAM)).toEqual([]);
      expect(await current()).toBeNull();
      const after = await state();
      expect(after.macrocycleScheduledWorkouts).toEqual([]);
      expect(after.workoutSkipOverrides).toEqual([]);
      expect(after.workoutDateOverrides).toEqual([]);
      expect(after.macrocycleDashboards).toEqual([]);
      // One backup, of the replaced rows.
      expect((await snapshots()).map((s) => s.kind)).toEqual(['overwrite']);
      await expectDenseInDateOrder();
    });

    it('reimports the same file in full once what it duplicated is gone', async () => {
      await commit([OLD]);
      const counts = (await scopeCounts()).all;
      const dry = await send([OLD], { scope: { kind: 'all' }, counts }, 'dry-run');
      expect(dry.statusCode).toBe(200);
      // Added on top, every row is a duplicate; replacing, every row is new.
      expect(dry.json<ImportDryRunResponse>()).toMatchObject({ created: OLD.length, skipped: 0 });
      const plain = await send([OLD], undefined, 'dry-run');
      expect(plain.json<ImportDryRunResponse>()).toMatchObject({ created: 0, skipped: OLD.length });
    });
  });

  describe('all imported history', () => {
    it('keeps live and legacy macrocycles and hand-recorded non-cycle workouts, and removes imported ones', async () => {
      // An imported run with an imported non-cycle workout beside it.
      const importedNonCycle: Row[] = [{ day: -170, lift: 'Bench Press', weight: 60, program: NON_CYCLE_PROGRAM }];
      await commit([[...OLD.map((r) => ({ ...r, program: 'rpt' })), ...importedNonCycle]]);
      const bundle = await repos();
      // A legacy macrocycle, as the import before the Assign step made.
      await bundle.macrocycle.createMany([
        { program: 'rpt', macrocycleNum: 9, startDate: utc(-300), endDate: utc(-296), status: 'unknown', origin: 'legacy' },
      ]);
      await bundle.liftRecord.appendLiftRecords('rpt', [
        { program: 'rpt', macrocycleNum: 9, workoutNum: 1, date: utc(-300), lift: 'Squat', setNum: 1, weight: 50, reps: 5, notes: '' },
      ]);
      await handNonCycle(-100);
      const live = await liveWithOverrides(-30);

      const counts = (await scopeCounts()).imported;
      expect(counts).toEqual({ sets: OLD.length + 1, macrocycles: 1, current: 0, shortened: 0 });
      await commit([NEW], { scope: { kind: 'imported' }, counts });

      const rows = await macrocycles();
      expect(rows.map((m) => [m.origin, m.startDate])).toEqual([
        ['legacy', utc(-300)],
        ['imported', utc(-150)],
        ['live', utc(-30)],
      ]);
      expect(rows.find((m) => m.origin === 'live')?.id).toBe(live.id);
      // The legacy set, the new file's, and the live macrocycle's.
      expect((await sets()).map((r) => Number(r.weight)).sort((a, b) => a - b)).toEqual([50, 135, ...NEW.map(() => 200)]);
      // The hand-recorded non-cycle set stays; the imported one goes.
      expect((await sets(NON_CYCLE_PROGRAM)).map((r) => r.weight)).toEqual([95]);
      expect((await current())?.macrocycleNum).toBe(3);
      await expectDenseInDateOrder();
    });
  });

  describe('a date range', () => {
    it('removes its sets, shortens macrocycles at its edges and moves a cut live start and its dashboard date', async () => {
      // Imported -100 to -90; live from -40, with sets on -40 and -10.
      const edge = run(-100, 6);
      await commit([edge]);
      const live = await liveWithOverrides(-40);
      await logOn(live.macrocycleNum, 2, -10);
      const before = await macrocycles();
      expect(before.map((m) => m.macrocycleNum)).toEqual([1, 2]);

      const scope: ImportOverwriteScope = { kind: 'range', from: day(-95), to: day(-40) };
      const counts = (await rangeCounts(-95, -40)).range;
      // -94, -92 and -90's three sets each, and the live macrocycle's first.
      expect(counts).toEqual({ sets: 10, macrocycles: 0, current: 0, shortened: 2 });
      const inside = run(-80, 3, 200);
      await commit([inside], { scope, counts });

      const rows = await macrocycles();
      expect(rows.map((m) => [m.origin, m.startDate, m.endDate])).toEqual([
        // Shortened at its end, which recomputes its dates.
        ['imported', utc(-100), utc(-96)],
        ['imported', utc(-80), utc(-76)],
        // Its start cut, so it starts on its first set left.
        ['live', utc(-10), null],
      ]);
      expect((await current())?.macrocycleStartDate).toMatch(new RegExp(`^${day(-10)}`));
      // The schedule and overrides of a shortened live macrocycle stay.
      const after = await state();
      expect(after.workoutSkipOverrides).toHaveLength(1);
      expect(after.macrocycleScheduledWorkouts).not.toHaveLength(0);
      // Numbers follow date after the move, with the new macrocycle in between.
      await expectDenseInDateOrder();
      expect(rows.find((m) => m.origin === 'live')).toMatchObject({ id: live.id, macrocycleNum: 3 });
    });

    it('removes a live macrocycle wholly inside it, with its schedule and overrides', async () => {
      const live = await liveWithOverrides(-30);
      await logOn(live.macrocycleNum, 2, -28);
      const counts = (await rangeCounts(-35, -20)).range;
      expect(counts).toEqual({ sets: 2, macrocycles: 1, current: 1, shortened: 0 });
      const inside = run(-34, 3, 200);
      await commit([inside], { scope: { kind: 'range', from: day(-35), to: day(-20) }, counts });

      expect((await macrocycles()).map((m) => m.origin)).toEqual(['imported']);
      expect(await current()).toBeNull();
      const after = await state();
      expect(after.macrocycleScheduledWorkouts).toEqual([]);
      expect(after.workoutSkipOverrides).toEqual([]);
      expect(after.workoutDateOverrides).toEqual([]);
    });

    it('refuses a range whose start is after its end', async () => {
      const res = await server().inject({
        method: 'GET',
        url: `/programs/rpt/import/overwrite-counts?from=${day(-10)}&to=${day(-20)}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    });

    it('counts the range alone, and Assign counts nothing until Replace is picked', async () => {
      await commit([OLD]);
      expect(Object.keys(await rangeCounts(-210, -195))).toEqual(['range']);
      expect(await assign(NEW)).not.toHaveProperty('overwrite');
    });
  });

  describe('confirming the counts', () => {
    it('rejects a commit whose confirmed counts no longer match, and changes nothing', async () => {
      await commit([OLD]);
      const counts = (await scopeCounts()).all;
      // A set logged since the lifter confirmed.
      await handNonCycle(-10);
      const before = await state();
      const res = await send([NEW], { scope: { kind: 'all' }, counts });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'overwrite-counts-changed', counts: { ...counts, sets: counts.sets + 1 } });
      expect(await state()).toEqual(before);
      expect(await snapshots()).toEqual([]);
    });

    it('changes nothing on a dry run', async () => {
      await commit([OLD]);
      await liveWithOverrides(-30);
      const before = await state();
      const counts = (await scopeCounts()).all;
      const res = await send([NEW], { scope: { kind: 'all' }, counts }, 'dry-run');
      expect(res.statusCode).toBe(200);
      expect(res.json<ImportDryRunResponse>()).toMatchObject({ created: NEW.length });
      expect(await state()).toEqual(before);
      expect(await snapshots()).toEqual([]);
    });
  });

  describe('undo', () => {
    it('puts back everything an overwrite of all history replaced, live schedule and overrides included', async () => {
      await commit([OLD]);
      await liveWithOverrides(-30);
      await handNonCycle(-100);
      const before = await state();
      const dashboard = await current();

      const { batchId } = await overwrite([NEW], { kind: 'all' });
      await undo(batchId);

      expect(await state()).toEqual(before);
      expect(await current()).toEqual(dashboard);
      // The backup was restored, so none is left.
      expect(await snapshots()).toEqual([]);
    });

    it('puts back what a date range removed and shortened', async () => {
      await commit([run(-100, 6)]);
      const live = await liveWithOverrides(-40);
      await logOn(live.macrocycleNum, 2, -10);
      const before = await state();
      const dashboard = await current();

      const { batchId } = await overwrite([run(-80, 3, 200)], { kind: 'range', from: day(-95), to: day(-40) });
      await undo(batchId);

      expect(await state()).toEqual(before);
      expect(await current()).toEqual(dashboard);
      expect(await snapshots()).toEqual([]);
    });

    it('puts back what an overwrite of imported history replaced', async () => {
      await commit([OLD]);
      await liveWithOverrides(-30);
      const before = await state();
      const { batchId } = await overwrite([NEW], { kind: 'imported' });
      await undo(batchId);
      expect(await state()).toEqual(before);
    });

    it('is refused with a reason once the backup has expired, and the new rows stay', async () => {
      await commit([OLD]);
      const { batchId } = await overwrite([NEW], { kind: 'all' });
      const [snapshot] = await snapshots();
      if (!snapshot) throw new Error('no backup');
      ((await repos()).dataSnapshot as InMemoryDataSnapshotRepository).setExpiry(snapshot.id, new Date(Date.now() - 1000));
      const after = await state();

      const res = await undoRequest(batchId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'overwrite-undo-backup-gone', reason: 'backup-gone' });
      expect(res.json().message).toMatch(/expired or was deleted/);
      expect(await state()).toEqual(after);
    });

    it('is refused with a reason once the backup is deleted, and the new rows stay', async () => {
      await commit([OLD]);
      const { batchId } = await overwrite([NEW], { kind: 'all' });
      const [snapshot] = await snapshots();
      if (!snapshot) throw new Error('no backup');
      const deleted = await server().inject({ method: 'DELETE', url: `/users/me/snapshots/${snapshot.id}`, headers: auth() });
      expect(deleted.statusCode).toBe(204);
      const after = await state();

      const res = await undoRequest(batchId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'overwrite-undo-backup-gone' });
      expect(await state()).toEqual(after);
      expect((await sets()).map((r) => r.weight)).toEqual(NEW.map(() => 200));
    });

    it('undoes overwrites newest first, and undoing both restores the original rows', async () => {
      await commit([OLD]);
      await liveWithOverrides(-30);
      const original = await state();
      const first = await overwrite([NEW], { kind: 'all' });
      const second = await overwrite([run(-120, 6, 300)], { kind: 'all' });

      const refused = await undoRequest(first.batchId);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'overwrite-undo-later-overwrite', reason: 'later-overwrite' });

      await undo(second.batchId);
      expect((await sets()).map((r) => r.weight)).toEqual(NEW.map(() => 200));
      await undo(first.batchId);
      expect(await state()).toEqual(original);
      expect(await snapshots()).toEqual([]);
    });

    it('undoes an earlier overwrite once a later one can no longer be undone', async () => {
      await commit([OLD]);
      const first = await overwrite([NEW], { kind: 'all' });
      await overwrite([run(-120, 6, 300)], { kind: 'all' });
      // Newest first, so this is the later overwrite's backup.
      const [later] = await snapshots();
      expect((await server().inject({ method: 'DELETE', url: `/users/me/snapshots/${later?.id}`, headers: auth() })).statusCode).toBe(204);

      await undo(first.batchId);
      expect((await sets()).filter((r) => r.weight === 100)).toHaveLength(OLD.length);
      expect((await sets()).filter((r) => r.weight === 300)).toHaveLength(OLD.length);
    });

    describe('after the history changed since', () => {
      /** An imported run, then a live macrocycle from day -40 with a set on day -10, then a range cutting its start. */
      const shortenLive = async () => {
        await commit([run(-100, 6)]);
        const live = await liveWithOverrides(-40);
        await logOn(live.macrocycleNum, 2, -10);
        const { batchId } = await overwrite([run(-44, 2, 200)], { kind: 'range', from: day(-45), to: day(-38) });
        const shortened = (await macrocycles()).find((m) => m.id === live.id);
        expect(shortened?.startDate).toEqual(utc(-10));
        return { live, batchId };
      };

      it('keeps a close made since, and the dashboard of the macrocycle that replaced the current one', async () => {
        const { live, batchId } = await shortenLive();
        expect((await page('POST', '/programs/rpt/macrocycles', { macrocycleDate: day(-5) })).statusCode).toBe(201);
        const closed = (await macrocycles()).find((m) => m.id === live.id);
        expect(closed?.status).not.toBe('in-progress');
        const dashboard = await current();

        await undo(batchId);

        const after = (await macrocycles()).find((m) => m.id === live.id);
        // The start the overwrite moved goes back; the close stays.
        expect(after).toMatchObject({ startDate: utc(-40), status: closed?.status, endDate: closed?.endDate });
        // Still the next macrocycle's, renumbered once the import's own macrocycle went.
        const next = (await macrocycles()).find((m) => m.startDate.getTime() === utc(-5).getTime());
        expect(await current()).toEqual({ ...dashboard, macrocycleNum: next?.macrocycleNum });
        expect((await sets()).filter((r) => r.macrocycleNum === after?.macrocycleNum).map((r) => r.date)).toContainEqual(utc(-40));
      });

      it('puts back a shortened macrocycle deleted since', async () => {
        const { live, batchId } = await shortenLive();
        expect((await page('DELETE', '/programs/rpt/macrocycles/current')).statusCode).toBe(204);
        expect((await macrocycles()).find((m) => m.id === live.id)).toBeUndefined();

        await undo(batchId);

        const back = (await macrocycles()).find((m) => m.id === live.id);
        // Its dashboard went with it, so it comes back closed on its last restored set.
        expect(back).toMatchObject({ startDate: utc(-40), endDate: utc(-40), origin: 'live' });
        expect(back?.status).not.toBe('in-progress');
        expect(await current()).toBeNull();
        expect((await sets()).filter((r) => r.macrocycleNum === back?.macrocycleNum).map((r) => r.date)).toEqual([utc(-40)]);
        await expectDenseInDateOrder();
      });

      it('puts back a shortened macrocycle deleted since closed, beside the one started since', async () => {
        const { live, batchId } = await shortenLive();
        expect((await page('DELETE', '/programs/rpt/macrocycles/current')).statusCode).toBe(204);
        expect((await page('POST', '/programs/rpt/macrocycles/initialize', { macrocycleDate: day(-5) })).statusCode).toBe(201);
        const dashboard = await current();

        await undo(batchId);

        const rows = await macrocycles();
        expect(rows.filter((m) => m.endDate === null)).toHaveLength(1);
        expect(rows.find((m) => m.id === live.id)).toMatchObject({ startDate: utc(-40), endDate: utc(-40) });
        const started = rows.find((m) => m.startDate.getTime() === utc(-5).getTime());
        expect(started?.endDate).toBeNull();
        expect(await current()).toEqual({ ...dashboard, macrocycleNum: started?.macrocycleNum });
        await expectDenseInDateOrder();
      });

      it('leaves out a shortened macrocycle deleted since when none of its sets come back', async () => {
        const { live, batchId } = await shortenLive();
        expect((await page('DELETE', '/programs/rpt/macrocycles/current')).statusCode).toBe(204);
        // The same set logged again since, on a macrocycle started since, so the backup's copy stays out.
        expect((await page('POST', '/programs/rpt/macrocycles/initialize', { macrocycleDate: day(-41) })).statusCode).toBe(201);
        const started = (await macrocycles()).find((m) => m.origin === 'live');
        const set = { lift: 'Bench Press', setNum: 1, weight: 135, reps: 5, macrocycleNum: started?.macrocycleNum, workoutNum: 1, date: day(-40) };
        expect((await page('POST', '/programs/rpt/lift-records', set)).statusCode).toBe(201);

        await undo(batchId);

        expect((await macrocycles()).find((m) => m.id === live.id)).toBeUndefined();
        expect((await sets()).filter((r) => r.date.getTime() === utc(-40).getTime())).toHaveLength(1);
        await expectDenseInDateOrder();
      });

      it('leaves out the sets of an import undone since', async () => {
        const older = await commit([OLD]);
        const { batchId } = await overwrite([NEW], { kind: 'all' });
        await undo(older.batchId);

        await undo(batchId);

        expect(await sets()).toEqual([]);
        expect(await snapshots()).toEqual([]);
      });

      it('moves a restored non-cycle workout past a number logged since on another day', async () => {
        await commit([OLD]);
        await handNonCycle(-100);
        const { batchId } = await overwrite([run(-60, 1, 200)], { kind: 'range', from: day(-101), to: day(-99) });
        expect(await sets(NON_CYCLE_PROGRAM)).toEqual([]);
        await handNonCycle(-50);

        await undo(batchId);

        const nonCycle = await sets(NON_CYCLE_PROGRAM);
        expect(nonCycle).toHaveLength(2);
        expect(nonCycle.map((r) => r.date)).toEqual(expect.arrayContaining([utc(-100), utc(-50)]));
        expect(new Set(nonCycle.map((r) => r.workoutNum)).size).toBe(2);
      });
    });

    it("isn't restored from Settings, which would put the history back beside the import", async () => {
      await commit([OLD]);
      await overwrite([NEW], { kind: 'all' });
      const [snapshot] = await snapshots();
      const res = await server().inject({ method: 'POST', url: `/users/me/snapshots/${snapshot?.id}/restore`, headers: auth() });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'overwrite-backup' });
    });

    it('stays listed for undo though it created no macrocycle', async () => {
      await commit([OLD]);
      // Replacing imported history with a file that creates no macrocycle.
      const counts = (await scopeCounts()).imported;
      const { batchId } = await commit([], { scope: { kind: 'imported' }, counts });
      const res = await server().inject({ method: 'GET', url: '/programs/rpt/import/batches', headers: auth() });
      expect(res.json<Array<{ id: string }>>().map((b) => b.id)).toEqual([batchId]);
    });
  });
});
