import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import type { LiftRecord } from '@lifting-logbook/core';
import { MACROCYCLE_ID_HEADER } from '@lifting-logbook/types';
import type {
  AssignContinueOffer,
  ImportAssignResponse,
  ImportBreakdown,
  ImportBreakdownContinue,
  ImportBreakdownStretch,
  ImportCommitResponse,
  LiftRecordResponse,
  MacrocycleDashboardResponse,
} from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { injectPage } from '../testing/macrocycle-id';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';
import { dispatchTool } from '../adapters/llm/agent-tools';

/**
 * In-memory E2E for continuing an imported run as the current macrocycle (#1180, proposal
 * decision 2): `mode=assign`'s offer, the commit, and its undo.
 */
describe('Import: continue a run as current (#1180, e2e, in-memory adapters)', () => {
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
  let user = 'import-continue-e2e-0';
  let nextUser = 0;
  beforeEach(async () => {
    user = `import-continue-e2e-${++nextUser}`;
    process.env[FLAG] = 'true';
    // Every day, so the remaining workouts have dates to take.
    await (await repos()).userSettings.upsertSettings({ workoutSchedule: { type: 'fixed', days: [0, 1, 2, 3, 4, 5, 6] } });
  });
  const auth = () => ({ authorization: `Bearer ${user}` });
  const repos = (): Promise<RepositoryBundle> =>
    app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });
  const server = () => app.getHttpAdapter().getInstance();

  // `today` pins the import date to the test's, so a run crossing midnight UTC can't move it.
  const importCsv = (csv: string, query: string, fields: Record<string, string> = {}) => {
    const boundary = '----ContinueBoundary';
    const parts = [
      ...Object.entries({ today: day(0), ...fields }).flatMap(([name, value]) => [`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', value]),
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

  const DAY_MS = 86_400_000;
  const TODAY = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const ymd = (date: Date) => date.toISOString().slice(0, 10);
  /** `n` days from today: negative is past. */
  const day = (n: number) => ymd(new Date(TODAY + n * DAY_MS));
  const utc = (n: number) => new Date(`${day(n)}T00:00:00Z`);

  const RPT_DAYS = [
    ['Bench Press', 'Barbell Row', 'Overhead Press'],
    ['Squat', 'Romanian Deadlift', 'Calf Raises'],
    ['Deadlift', 'Weighted Pull-ups', 'Dips'],
  ];

  interface Row {
    day: number;
    lift: string;
    weight?: number;
    reps?: number;
    notes?: string;
    program?: string;
  }

  /** `count` RPT sessions, every other day from `start`. */
  const run = (start: number, count: number): Row[] =>
    Array.from({ length: count }, (_, i) => (RPT_DAYS[i % 3] ?? []).map((lift) => ({ day: start + i * 2, lift, notes: 'from the file' }))).flat();

  /** A CSV of the rows, with a Program column when any row names one. */
  const csvOf = (rows: Row[]) => {
    const withProgram = rows.some((r) => r.program !== undefined);
    return [
      `${withProgram ? 'Program,' : ''}Date,Lift,Set #,Weight,Reps,Notes`,
      ...rows.map((r) =>
        [...(withProgram ? [r.program ?? ''] : []), day(r.day), r.lift, 1, r.weight ?? 100, r.reps ?? 8, r.notes ?? ''].join(','),
      ),
    ].join('\n');
  };

  const stretch = (rows: Row[], extra: Partial<ImportBreakdownStretch> = {}): ImportBreakdownStretch => ({
    program: 'rpt',
    dates: [...new Set(rows.map((r) => r.day))].sort((a, b) => a - b).map(day),
    status: 'completed',
    statusChosen: false,
    ...extra,
  });

  const breakdownOf = (stretches: ImportBreakdownStretch[], continued?: ImportBreakdownContinue): ImportBreakdown => ({
    stretches,
    excludedDates: [],
    nonCycleDates: [],
    ...(continued ? { continue: continued } : {}),
  });

  const assign = async (rows: Row[]) => {
    const res = await importCsv(csvOf(rows), '?mode=assign&destination=lift-records');
    expect(res.statusCode).toBe(200);
    return res.json<ImportAssignResponse>();
  };

  const send = (rows: Row[], breakdown: ImportBreakdown, mode: 'commit' | 'dry-run' = 'commit') =>
    importCsv(csvOf(rows), `?mode=${mode}&destination=lift-records`, { breakdown: JSON.stringify(breakdown) });

  const commit = async (rows: Row[], breakdown: ImportBreakdown) => {
    const res = await send(rows, breakdown);
    expect(res.statusCode).toBe(200);
    return res.json<ImportCommitResponse>();
  };

  /** The offer's lifts, each overwritten with its computed value, else `fallback`. */
  const everyMax = (offer: AssignContinueOffer, fallback = 120) =>
    offer.maxes.map((m) => ({ lift: m.lift, weight: m.computed ?? fallback }));

  /** Imports `rows` as one stretch continued as current, with every max set. */
  const continueRun = async (rows: Row[], extra: Partial<ImportBreakdownContinue> = {}) => {
    const offer = (await assign(rows)).continue;
    if (!offer) throw new Error('expected a continue offer');
    const body = await commit(rows, breakdownOf([stretch(rows)], { stretch: 0, maxes: everyMax(offer), ...extra }));
    return { offer, body };
  };

  const undoRequest = (batchId: string | null) =>
    server().inject({ method: 'POST', url: `/programs/rpt/import/${batchId}/undo`, headers: auth() });

  const undo = async (batchId: string | null) => {
    const res = await undoRequest(batchId);
    expect(res.statusCode).toBe(200);
    return res.json<{ restored: number; skipped: number; flagged: Array<{ key: string; reason: string }> }>();
  };

  const macrocycles = async () => (await repos()).macrocycle.list('rpt');
  const current = async () => {
    const res = await server().inject({ method: 'GET', url: '/programs/rpt/macrocycles/current', headers: auth() });
    return res.statusCode === 200 ? res.json<MacrocycleDashboardResponse>() : null;
  };

  /** Starts a live RPT macrocycle on `start` and logs one set on it. */
  const liveWithASet = async (start: number) => {
    expect((await page('POST', '/programs/rpt/macrocycles/initialize', { macrocycleDate: day(start) })).statusCode).toBe(201);
    const [live] = await macrocycles();
    if (!live) throw new Error('no live macrocycle');
    const set = { lift: 'Bench Press', setNum: 1, weight: 135, reps: 5, macrocycleNum: live.macrocycleNum, workoutNum: 1, date: day(start) };
    expect((await page('POST', '/programs/rpt/lift-records', set)).statusCode).toBe(201);
    return live;
  };

  /** Logs a set on the current macrocycle's next workout, today. */
  const logOnCurrent = async (fields: Partial<{ notes: string; modifications: string[]; weight: number; reps: number }> = {}) => {
    const dashboard = await current();
    if (!dashboard) throw new Error('no current macrocycle');
    const bundle = await repos();
    const done = await bundle.liftRecord.getLoggedWorkoutNums('rpt', dashboard.macrocycleNum);
    const set = {
      lift: 'Bench Press',
      setNum: 1,
      weight: 140,
      reps: 6,
      macrocycleNum: dashboard.macrocycleNum,
      workoutNum: Math.max(0, ...done) + 1,
      date: day(0),
      ...fields,
    };
    const res = await page('POST', '/programs/rpt/lift-records', set);
    expect(res.statusCode).toBe(201);
    return res.json<LiftRecordResponse>();
  };

  // Seven sessions, the last four days ago: 7 of RPT's 24 workouts done.
  const RECENT = run(-16, 7);

  describe('the offer', () => {
    it('is made on the last stretch of a known program with workouts left and a recent last session, with no maxes stored', async () => {
      const older = run(-120, 6);
      const assigned = await assign([...older, ...RECENT]);
      expect(assigned.stretches).toHaveLength(2);
      expect(assigned.continue).toMatchObject({ stretch: 1, live: null });
      // A value per lift the program plans, none of them stored.
      expect(assigned.continue?.maxes.length).toBeGreaterThan(0);
      expect(assigned.continue?.maxes.every((m) => m.current === null)).toBe(true);
      expect(assigned.continue?.maxes.map((m) => m.lift)).toEqual(expect.arrayContaining(['Bench Press', 'Squat', 'Deadlift']));
    });

    it("isn't made on an older stretch, and a commit continuing one is refused", async () => {
      const older = run(-60, 6);
      const assigned = await assign([...older, ...RECENT]);
      expect(assigned.continue?.stretch).toBe(1);
      const offer = assigned.continue;
      if (!offer) throw new Error('expected an offer');
      const res = await send([...older, ...RECENT], breakdownOf([stretch(older), stretch(RECENT)], { stretch: 0, maxes: everyMax(offer) }));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'continue-refused', reason: 'not-last' });
      // A file whose last stretch is stale offers nothing on an earlier one either.
      expect((await assign([...run(-120, 6), ...run(-60, 6)])).continue).toBeNull();
    });

    it("isn't made on a finished run", async () => {
      // All 24 workouts, the last two days ago.
      expect((await assign(run(-48, 24))).continue).toBeNull();
    });

    it("isn't made on a stretch matched to no program", async () => {
      // A Program column naming no known program leaves the stretch for the lifter to map.
      const assigned = await assign(RECENT.map((r) => ({ ...r, program: 'GZCLP' })));
      expect(assigned.stretches).toHaveLength(1);
      expect(assigned.stretches.at(-1)?.matched).toBe(false);
      expect(assigned.continue).toBeNull();
    });

    it("isn't made on a run whose last session is over 14 days old", async () => {
      expect((await assign(run(-30, 7))).continue).toBeNull();
      expect((await assign(run(-26, 7))).continue).not.toBeNull();
    });

    it("isn't made on a run overlapping a stored macrocycle, and a commit continuing one is refused", async () => {
      // A live macrocycle started during the run, with a set logged in it.
      await liveWithASet(-10);
      const assigned = await assign(RECENT);
      expect(assigned.stretches.map((s) => s.stored.kind)).toEqual(['overlaps']);
      expect(assigned.continue).toBeNull();
      const res = await send(RECENT, breakdownOf([stretch(RECENT)], { stretch: 0, maxes: [] }));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'continue-refused', reason: 'overlaps' });
    });

    it("isn't made on a run that ends before a stored macrocycle of its program, and a commit continuing one is refused", async () => {
      // A live macrocycle started after the run's last session.
      await liveWithASet(-2);
      const assigned = await assign(RECENT);
      expect(assigned.stretches.map((s) => s.stored.kind)).toEqual(['new']);
      expect(assigned.continue).toBeNull();
      const res = await send(RECENT, breakdownOf([stretch(RECENT)], { stretch: 0, maxes: [] }));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'continue-refused', reason: 'not-last' });
    });

    it('names the live macrocycle it would end, with its set count', async () => {
      const live = await liveWithASet(-40);
      expect((await assign(RECENT)).continue?.live).toEqual({ id: live.id, macrocycleNum: live.macrocycleNum, sets: 1 });
    });
  });

  describe('the commit', () => {
    it('makes the run current: live, active, scheduled from after the import date, and loggable', async () => {
      await continueRun(RECENT, {});
      const [run] = await macrocycles();
      expect(run).toMatchObject({ origin: 'live', status: 'in-progress', endDate: null, importedThrough: utc(-4) });
      const dashboard = await current();
      expect(dashboard?.macrocycleNum).toBe(run?.macrocycleNum);
      const bundle = await repos();
      expect((await bundle.userSettings.getSettings()).activeProgram).toBe('rpt');

      const scheduled = await bundle.macrocycleScheduledWorkout.getScheduledWorkouts('rpt', run?.macrocycleNum ?? -1);
      // 24 workouts, 7 done: the rest are scheduled, every one after today.
      expect(scheduled.map((s) => s.workoutNum).sort((a, b) => a - b)).toEqual(Array.from({ length: 17 }, (_, i) => i + 8));
      expect(scheduled.every((s) => new Date(s.scheduledDate).getTime() > TODAY)).toBe(true);

      const logged = await logOnCurrent();
      expect(logged).toMatchObject({ workoutNum: 8, weight: 140 });
    });

    it('stores the run in progress whatever status its stretch was given', async () => {
      const offer = (await assign(RECENT)).continue;
      if (!offer) throw new Error('expected an offer');
      await commit(RECENT, breakdownOf([stretch(RECENT, { status: 'completed', statusChosen: true })], { stretch: 0, maxes: everyMax(offer) }));
      expect(await macrocycles()).toEqual([expect.objectContaining({ status: 'in-progress', statusChosen: false })]);
    });

    it('refuses to end a live macrocycle without agreement, and with it closes the row and keeps its sets', async () => {
      const live = await liveWithASet(-40);
      const offer = (await assign(RECENT)).continue;
      if (!offer) throw new Error('expected an offer');
      const breakdown = (endLive?: string) =>
        breakdownOf([stretch(RECENT)], { stretch: 0, maxes: everyMax(offer), ...(endLive ? { endLive } : {}) });

      const refused = await send(RECENT, breakdown());
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'continue-refused', reason: 'needs-agreement' });
      expect(refused.json<{ message: string }>().message).toContain('1 set');
      expect((await send(RECENT, breakdown('some-other-id'))).statusCode).toBe(400);
      expect(await macrocycles()).toHaveLength(1);

      await commit(RECENT, breakdown(live.id));
      const ended = (await macrocycles()).find((m) => m.id === live.id);
      expect(ended).toMatchObject({ endDate: utc(-40) });
      expect(ended?.status).not.toBe('in-progress');
      expect(await (await repos()).liftRecord.getLiftRecords('rpt', ended?.macrocycleNum ?? -1)).toHaveLength(1);
      expect((await current())?.macrocycleNum).not.toBe(ended?.macrocycleNum);
    });

    it('keeps a max left out, overwrites one given, and needs a value for a lift with none', async () => {
      const bundle = await repos();
      const old = new Date('2020-01-01T00:00:00Z');
      await bundle.trainingMax.saveTrainingMaxes('rpt', [
        { lift: 'Bench Press', weight: 180, dateUpdated: old },
        { lift: 'Squat', weight: 200, dateUpdated: old },
      ]);
      const offer = (await assign(RECENT)).continue;
      if (!offer) throw new Error('expected an offer');
      const squat = offer.maxes.find((m) => m.lift === 'Squat');
      // The run's squat sets reach RPT's target, so they move the max.
      expect(squat).toMatchObject({ current: 200, computed: expect.any(Number) });
      const squatValue = squat?.computed ?? 0;
      const unstored = offer.maxes.filter((m) => m.current === null).map((m) => ({ lift: m.lift, weight: m.computed ?? 95 }));

      // A lift with no max and no value can't commit.
      const missing = await send(RECENT, breakdownOf([stretch(RECENT)], { stretch: 0, maxes: unstored.slice(1) }));
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ reason: 'max-required' });
      expect(await macrocycles()).toEqual([]);

      await commit(RECENT, breakdownOf([stretch(RECENT)], { stretch: 0, maxes: [{ lift: 'Squat', weight: squatValue }, ...unstored] }));
      const maxes = await bundle.trainingMax.getTrainingMaxes('rpt');
      expect(maxes.find((m) => m.lift === 'Bench Press')).toMatchObject({ weight: 180, dateUpdated: old });
      expect(maxes.find((m) => m.lift === 'Squat')).toMatchObject({ weight: squatValue });
      for (const { lift, weight } of unstored) expect(maxes.find((m) => m.lift === lift)?.weight).toBe(weight);
    });

    it("dates an overwritten max at the run's last session, and leaves one entered at its current weight alone", async () => {
      const bundle = await repos();
      const old = new Date('2020-01-01T00:00:00Z');
      await bundle.trainingMax.saveTrainingMaxes('rpt', [
        { lift: 'Bench Press', weight: 180, dateUpdated: old },
        { lift: 'Squat', weight: 200, dateUpdated: old },
      ]);
      const offer = (await assign(RECENT)).continue;
      if (!offer) throw new Error('expected an offer');
      const unstored = offer.maxes.filter((m) => m.current === null).map((m) => ({ lift: m.lift, weight: m.computed ?? 95 }));
      const { batchId } = await commit(
        RECENT,
        breakdownOf([stretch(RECENT)], {
          stretch: 0,
          maxes: [{ lift: 'Bench Press', weight: 180 }, { lift: 'Squat', weight: 210 }, ...unstored],
        }),
      );
      const maxes = await bundle.trainingMax.getTrainingMaxes('rpt');
      expect(maxes.find((m) => m.lift === 'Bench Press')).toMatchObject({ weight: 180, dateUpdated: old });
      // RECENT's last session is four days ago.
      expect(maxes.find((m) => m.lift === 'Squat')).toMatchObject({ weight: 210, dateUpdated: utc(-4) });

      const result = await undo(batchId);
      expect(result.flagged).toEqual([]);
      const after = await bundle.trainingMax.getTrainingMaxes('rpt');
      expect(after.find((m) => m.lift === 'Bench Press')).toMatchObject({ weight: 180, dateUpdated: old });
      expect(after.find((m) => m.lift === 'Squat')).toMatchObject({ weight: 200, dateUpdated: old });
    });

    it('refuses a continue on a run that may not continue', async () => {
      const stale = run(-40, 7);
      const res = await send(stale, breakdownOf([stretch(stale)], { stretch: 0, maxes: [] }));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'continue-refused', reason: 'stale' });
    });
  });

  describe('undo', () => {
    it('puts back the pointer, active program, ended macrocycle, max and schedule, after an older import renumbers it', async () => {
      const live = await liveWithASet(-40);
      const bundle = await repos();
      const old = new Date('2020-01-01T00:00:00Z');
      await bundle.trainingMax.saveTrainingMaxes('rpt', [{ lift: 'Squat', weight: 200, dateUpdated: old }]);
      const before = {
        dashboard: await bundle.macrocycleDashboard.getMacrocycleDashboard('rpt'),
        activeProgram: (await bundle.userSettings.getSettings()).activeProgram,
        live: await bundle.macrocycle.findById(live.id),
        schedule: await bundle.macrocycleScheduledWorkout.getScheduledWorkouts('rpt', live.macrocycleNum),
      };

      const { body } = await continueRun(RECENT, { endLive: live.id });
      // The squat max was overwritten.
      expect((await bundle.trainingMax.getTrainingMaxes('rpt')).find((m) => m.lift === 'Squat')?.dateUpdated).not.toEqual(old);

      // Older history goes first in date order, so the ended macrocycle's number moves.
      const older = run(-150, 6);
      await commit(older, breakdownOf([stretch(older)]));
      expect((await bundle.macrocycle.findById(live.id))?.macrocycleNum).toBe(live.macrocycleNum + 1);

      await undo(body.batchId);
      const ended = await bundle.macrocycle.findById(live.id);
      expect(ended).toMatchObject({ endDate: before.live?.endDate, status: before.live?.status, macrocycleNum: 2 });
      expect((await bundle.macrocycleDashboard.getMacrocycleDashboard('rpt'))).toEqual({ ...before.dashboard, macrocycleNum: 2 });
      expect((await bundle.userSettings.getSettings()).activeProgram).toBe(before.activeProgram);
      expect((await bundle.trainingMax.getTrainingMaxes('rpt')).find((m) => m.lift === 'Squat')).toMatchObject({ weight: 200, dateUpdated: old });
      expect(await bundle.macrocycleScheduledWorkout.getScheduledWorkouts('rpt', 2)).toEqual(before.schedule);
      // The older import stays, numbered first.
      expect((await macrocycles()).map((m) => [m.macrocycleNum, m.origin])).toEqual([
        [1, 'imported'],
        [2, 'live'],
      ]);
    });

    it('keeps a set logged since the import as a non-cycle workout, and removes the rest of the run', async () => {
      const older = run(-150, 6);
      await commit(older, breakdownOf([stretch(older)]));
      const { body } = await continueRun(RECENT);
      const [, runRow] = await macrocycles();
      if (!runRow) throw new Error('no run');
      const created = await page('POST', '/lifts/modifications', { lift: 'Bench Press', name: 'Paused' });
      expect(created.statusCode).toBe(201);
      const modification = created.json<{ id: string }>().id;
      await logOnCurrent({ notes: 'felt strong', modifications: [modification], weight: 145, reps: 7 });
      const bundle = await repos();
      await bundle.workoutDateOverride.upsertOverride('rpt', runRow.macrocycleNum, 9, utc(3));

      await undo(body.batchId);
      const moved = await server().inject({ method: 'GET', url: '/non-cycle-workouts', headers: auth() });
      expect(moved.statusCode).toBe(200);
      const [set, ...others] = moved.json<LiftRecordResponse[]>();
      expect(others).toEqual([]);
      expect(set).toMatchObject({ date: day(0), weight: 145, reps: 7, notes: 'felt strong', modifications: [{ id: modification }] });

      // The run's row, imported sets, schedule, overrides and the pointer at it are gone.
      expect((await macrocycles()).map((m) => [m.macrocycleNum, m.origin])).toEqual([[1, 'imported']]);
      expect(await bundle.liftRecord.getLiftRecords('rpt', runRow.macrocycleNum)).toEqual([]);
      expect(await bundle.macrocycleScheduledWorkout.getScheduledWorkouts('rpt', runRow.macrocycleNum)).toEqual([]);
      expect((await bundle.workoutDateOverride.getOverridesForMacrocycle('rpt', runRow.macrocycleNum)).size).toBe(0);
      expect(await current()).toBeNull();

      // History shows it as a workout, and the set can be edited there.
      const workout = await server().inject({ method: 'GET', url: `/non-cycle-workouts/${set?.workoutNum}`, headers: auth() });
      expect(workout.statusCode).toBe(200);
      const { macrocycleId, records } = workout.json<{ macrocycleId: string; records: LiftRecordResponse[] }>();
      expect(records.map((r) => r.id)).toEqual([set?.id]);
      const edit = await server().inject({
        method: 'PATCH',
        url: `/programs/non-cycle/lift-records/${encodeURIComponent(set?.id ?? '')}`,
        headers: { 'content-type': 'application/json', [MACROCYCLE_ID_HEADER]: macrocycleId, ...auth() },
        payload: JSON.stringify({ weight: 150 }),
      });
      expect(edit.statusCode).toBe(200);
      expect(edit.json<LiftRecordResponse>().weight).toBe(150);
    });

    it('is refused once the next macrocycle starts', async () => {
      const { body } = await continueRun(RECENT);
      expect((await page('POST', '/programs/rpt/macrocycles', { macrocycleDate: day(1) })).statusCode).toBe(201);
      const res = await undoRequest(body.batchId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'import-undo-refused' });
      expect(res.json<{ message: string }>().message).toContain('no longer your current one');
      expect(await macrocycles()).toHaveLength(2);
    });

    it('is refused once the run is deleted', async () => {
      const { body } = await continueRun(RECENT);
      expect((await page('DELETE', '/programs/rpt/macrocycles/current')).statusCode).toBeLessThan(300);
      const res = await undoRequest(body.batchId);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ message: string }>().message).toContain('deleted');
    });

    it('is refused once another import adds sets to the run', async () => {
      const { body } = await continueRun(RECENT);
      const [runRow] = await macrocycles();
      // A file-number import joins the current macrocycle while its run is open.
      const csv = ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes', `rpt,1,8,${day(0)},Bench Press,1,140,6,`].join('\n');
      expect((await importCsv(csv, '?mode=commit&destination=lift-records')).statusCode).toBe(200);
      const bundle = await repos();
      expect(await bundle.liftRecord.getLiftRecords('rpt', runRow?.macrocycleNum ?? -1)).toHaveLength(RECENT.length + 1);

      const res = await undoRequest(body.batchId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'import-undo-refused' });
      expect(res.json<{ message: string }>().message).toContain('Another import');
      // Nothing changed: the run is current, with every set.
      expect((await current())?.macrocycleNum).toBe(runRow?.macrocycleNum);
      expect(await bundle.liftRecord.getLiftRecords('rpt', runRow?.macrocycleNum ?? -1)).toHaveLength(RECENT.length + 1);
    });

    it('skips and flags a max changed since the import', async () => {
      const { body } = await continueRun(RECENT);
      const bundle = await repos();
      await bundle.trainingMax.saveTrainingMaxes('rpt', [{ lift: 'Squat', weight: 999, dateUpdated: utc(0) }]);
      const result = await undo(body.batchId);
      expect(result.flagged.map((f) => f.key)).toContain('Squat');
      expect((await bundle.trainingMax.getTrainingMaxes('rpt')).find((m) => m.lift === 'Squat')?.weight).toBe(999);
    });
  });

  it("leaves the planning agent no notes on the run's sets up to importedThrough, and keeps later ones'", async () => {
    await continueRun(RECENT);
    await logOnCurrent({ notes: 'logged in the app' });
    const [runRow] = await macrocycles();
    const num = runRow?.macrocycleNum ?? -1;
    const result = await dispatchTool('get_lift_history', { macrocycleNum: num }, await repos(), {
      program: 'rpt',
      goal: 'strength',
      macrocycleNum: num + 1,
    });
    expect(result.ok).toBe(true);
    const records = result.data as LiftRecord[];
    const through = runRow?.importedThrough?.getTime() ?? 0;
    const imported = records.filter((r) => new Date(r.date).getTime() <= through);
    expect(imported.length).toBe(RECENT.length);
    expect(imported.every((r) => r.notes === '')).toBe(true);
    expect(records.filter((r) => new Date(r.date).getTime() > through).map((r) => r.notes)).toEqual(['logged in the app']);
    // The stored sets keep their notes: only what reaches the provider leaves them out.
    expect((await (await repos()).liftRecord.getLiftRecords('rpt', num)).filter((r) => r.notes === 'from the file')).toHaveLength(RECENT.length);
  });
});
