import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import type { LiftRecord } from '@lifting-logbook/core';
import type {
  ImportAssignResponse,
  ImportBatchSummary,
  ImportBreakdown,
  ImportBreakdownStretch,
  ImportCommitResponse,
  ImportDryRunResponse,
  ImportPreviewResponse,
} from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { injectPage } from '../testing/macrocycle-id';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from './conflict.filter';
import { DomainNotFoundFilter } from './not-found.filter';
import { NON_CYCLE_MACROCYCLE_NUM } from './non-cycle.util';
import { InMemoryMacrocycleRepository } from '../adapters/in-memory/macrocycle.adapter';

/**
 * In-memory E2E for an import through the Assign step (#1254): `mode=dry-run` and commit with the
 * lifter's confirmed breakdown, and its undo. The concurrency, failure and row-limit criteria
 * need Postgres, so they're in `import-breakdown.db.e2e.spec.ts`.
 */
describe('Import breakdown (#1254, e2e, in-memory adapters)', () => {
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
  let user = 'import-breakdown-e2e-0';
  let nextUser = 0;
  beforeEach(() => {
    user = `import-breakdown-e2e-${++nextUser}`;
    process.env[FLAG] = 'true';
  });
  const auth = () => ({ authorization: `Bearer ${user}` });
  const repos = (): Promise<RepositoryBundle> =>
    app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: user, email: `${user}@example.com`, provider: 'dev' });

  const importCsv = (program: string, csv: string, query: string, fields: Record<string, string> = {}) => {
    const boundary = '----BreakdownBoundary';
    const parts = [
      ...Object.entries(fields).flatMap(([name, value]) => [
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
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/programs/${encodeURIComponent(program)}/import${query}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...auth() },
      payload: parts.join('\r\n'),
    });
  };

  const DAY_MS = 86_400_000;
  const START = Math.floor(Date.now() / DAY_MS) * DAY_MS - 200 * DAY_MS;
  const ymd = (date: Date) => date.toISOString().slice(0, 10);
  const day = (n: number) => ymd(new Date(START + n * DAY_MS));

  const RPT_DAYS = [
    ['Bench Press', 'Barbell Row', 'Overhead Press'],
    ['Squat', 'Romanian Deadlift', 'Calf Raises'],
    ['Deadlift', 'Weighted Pull-ups', 'Dips'],
  ];
  const FIVE_THREE_ONE_DAYS = [
    ['Squat', 'Bench Press'],
    ['Deadlift', 'Overhead Press'],
  ];

  interface Row {
    day: number | null;
    lift: string;
    program?: string;
    macrocycle?: number;
    workout?: number;
    notes?: string;
    weight?: number;
  }

  /** `count` sessions cycling through `days`, every other day from `start`. */
  const run = (days: string[][], start: number, count: number, extra: Partial<Row> = {}): Row[] =>
    Array.from({ length: count }, (_, i) =>
      (days[i % days.length] ?? []).map((lift) => ({ day: start + i * 2, lift, ...extra })),
    ).flat();

  /** A CSV with only the columns the rows use beyond date, lift, set, weight and reps. */
  const csvOf = (rows: Row[], extraHeaders: string[] = []) => {
    const withProgram = rows.some((r) => r.program !== undefined);
    const withNumbers = rows.some((r) => r.macrocycle !== undefined || r.workout !== undefined);
    const header = [
      ...(withProgram ? ['Program'] : []),
      ...(withNumbers ? ['Cycle #', 'Workout #'] : []),
      'Date',
      'Lift',
      'Set #',
      'Weight',
      'Reps',
      'Notes',
      ...extraHeaders,
    ];
    const lines = rows.map((r) =>
      [
        ...(withProgram ? [r.program ?? ''] : []),
        ...(withNumbers ? [r.macrocycle ?? '', r.workout ?? ''] : []),
        r.day === null ? '' : day(r.day),
        r.lift,
        1,
        r.weight ?? 100,
        5,
        r.notes ?? '',
        ...extraHeaders.map(() => 0),
      ].join(','),
    );
    return [header.join(','), ...lines].join('\n');
  };

  /** The distinct dates of `rows`, oldest first. */
  const datesOf = (rows: Row[]) =>
    [...new Set(rows.filter((r) => r.day !== null).map((r) => r.day as number))].sort((a, b) => a - b).map(day);

  const stretch = (rows: Row[], program = 'rpt', extra: Partial<ImportBreakdownStretch> = {}): ImportBreakdownStretch => ({
    program,
    dates: datesOf(rows),
    status: 'completed',
    statusChosen: false,
    ...extra,
  });

  const breakdownOf = (stretches: ImportBreakdownStretch[], extra: Partial<ImportBreakdown> = {}): ImportBreakdown => ({
    stretches,
    excludedDates: [],
    nonCycleDates: [],
    ...extra,
  });

  const send = (mode: 'commit' | 'dry-run', csv: string, breakdown: ImportBreakdown, query = '', program = 'rpt') =>
    importCsv(program, csv, `?mode=${mode}&destination=lift-records${query}`, { breakdown: JSON.stringify(breakdown) });

  const commit = async (csv: string, breakdown: ImportBreakdown, query = '') => {
    const res = await send('commit', csv, breakdown, query);
    expect(res.statusCode).toBe(200);
    return res.json<ImportCommitResponse>();
  };

  const dryRun = async (csv: string, breakdown: ImportBreakdown, query = '') => {
    const res = await send('dry-run', csv, breakdown, query);
    expect(res.statusCode).toBe(200);
    return res.json<ImportDryRunResponse>();
  };

  const undoRequest = (batchId: string | null, program = 'rpt', today?: string) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/programs/${program}/import/${batchId}/undo${today === undefined ? '' : `?today=${today}`}`,
      headers: auth(),
    });

  const undo = async (batchId: string | null, program = 'rpt', today?: string) => {
    const res = await undoRequest(batchId, program, today);
    expect(res.statusCode).toBe(200);
    return res.json<{ restored: number; skipped: number; flagged: unknown[] }>();
  };

  const macrocycles = async (program = 'rpt') => (await repos()).macrocycle.list(program);

  /** Every set stored under `program`, read through its macrocycle rows. */
  const stored = async (program = 'rpt'): Promise<LiftRecord[]> => {
    const bundle = await repos();
    const sets: LiftRecord[] = [];
    for (const m of await bundle.macrocycle.list(program)) {
      sets.push(...(await bundle.liftRecord.getLiftRecords(program, m.macrocycleNum)));
    }
    return sets;
  };

  const counts = async () => ({
    sets: (await stored('rpt')).length + (await stored('5-3-1')).length + (await stored('non-cycle')).length,
    macrocycles: (await macrocycles('rpt')).length + (await macrocycles('5-3-1')).length,
  });

  it('commits a file with no program, macrocycle or workout columns', async () => {
    const rows = run(RPT_DAYS, 0, 3);
    const body = await commit(csvOf(rows), breakdownOf([stretch(rows, 'rpt', { statusChosen: true })]));

    expect(body).toMatchObject({ created: 9, skipped: 0 });
    expect(body.assigned).toMatchObject({ macrocycles: 1, nonCycleSessions: 0, excludedSessions: 0, undatedRows: 0 });
    const [row, ...others] = await macrocycles();
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      origin: 'imported',
      status: 'completed',
      statusChosen: true,
      unmatched: false,
      startDate: new Date(`${day(0)}T00:00:00Z`),
      endDate: new Date(`${day(4)}T00:00:00Z`),
    });
    const sets = await stored();
    expect(sets).toHaveLength(9);
    expect(new Set(sets.map((s) => s.macrocycleNum))).toEqual(new Set([row?.macrocycleNum]));
    // No file numbers: each session's workout number is its place in the stretch.
    expect(sets.filter((s) => s.date.getTime() === new Date(`${day(4)}T00:00:00Z`).getTime()).map((s) => s.workoutNum)).toEqual([3, 3, 3]);
    // Each lift written, once, as stored (#1273).
    expect(body.lifts).toHaveLength(9);
    expect([...(body.lifts ?? [])].sort()).toEqual([...new Set(sets.map((s) => s.lift))].sort());
  });

  it("lists only the lifts written to the importing program (#1273)", async () => {
    // RPT's stretch has only Bench Press; the 5/3/1 stretch's Squat and Deadlift go to another program.
    const rpt = run([['Bench Press']], 0, 2);
    const fiveThreeOne = run([['Squat', 'Deadlift']], 10, 2);
    const body = await commit(csvOf([...rpt, ...fiveThreeOne]), breakdownOf([stretch(rpt), stretch(fiveThreeOne, '5-3-1')]));

    expect(body.created).toBe(6);
    expect(body.lifts).toEqual(['bench-press']);
  });

  it('lists no lift that only a lone non-cycle session holds (#1273)', async () => {
    const rpt = run([['Bench Press']], 0, 2);
    const lone: Row[] = [{ day: 19, lift: 'Dips' }];
    const body = await commit(csvOf([...rpt, ...lone]), breakdownOf([stretch(rpt)], { nonCycleDates: [day(19)] }));

    expect(body.created).toBe(3);
    expect(body.assigned).toMatchObject({ nonCycleSessions: 1 });
    expect(body.lifts).toEqual(['bench-press']);
  });

  it('marks a stretch unmatched when it holds lifts outside its program', async () => {
    // Barbell Row and the rest of the RPT day aren't 5/3/1 lifts.
    const rows = run(RPT_DAYS, 0, 2);
    await commit(csvOf(rows), breakdownOf([stretch(rows, '5-3-1', { status: 'abandoned' })]));
    expect(await macrocycles('5-3-1')).toEqual([
      expect.objectContaining({ origin: 'imported', status: 'abandoned', statusChosen: false, unmatched: true }),
    ]);
  });

  it('stores rows with blank number cells in their stretch, not under number 0', async () => {
    // Row 1 is numbered; day 2's rows leave Cycle # and Workout # blank.
    const rows = [{ day: 0, lift: 'Bench Press', macrocycle: 1, workout: 1 }, ...run(RPT_DAYS, 2, 1)];
    const body = await commit(csvOf(rows), breakdownOf([stretch(rows)]));

    expect(body.created).toBe(4);
    const [row] = await macrocycles();
    const sets = await stored();
    expect(sets).toHaveLength(4);
    expect(sets.every((s) => s.macrocycleNum === row?.macrocycleNum && s.macrocycleNum !== 0)).toBe(true);
    expect(sets.map((s) => s.workoutNum).sort()).toEqual([1, 2, 2, 2]);
  });

  it("doesn't split an exported file's one-rep-max rows, through preview, dry run and commit", async () => {
    const rows = [
      ...run(RPT_DAYS, 0, 3, { program: 'rpt', macrocycle: 1 }),
      { day: 5, lift: 'Squat', program: 'rpt', macrocycle: 1, notes: '1RM test', weight: 315 },
    ];
    const csv = csvOf(rows, ['Occurrence']);
    const breakdown = breakdownOf([
      { program: 'rpt', file: { group: 'rpt', macrocycleNum: 1 }, status: 'completed', statusChosen: false },
    ]);

    const previewed = await importCsv('rpt', csv, '?destination=lift-records&splitDest=1');
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json<ImportPreviewResponse>().split).toBeUndefined();

    const dry = await dryRun(csv, breakdown, '&splitDest=1');
    expect(dry.split).toBeUndefined();
    expect(dry.created).toBe(10);
    expect(dry.assigned?.splitOlderThanCurrent).toBe(0);

    const body = await commit(csv, breakdown, '&splitDest=1');
    expect(body.split).toBeUndefined();
    expect(body.created).toBe(10);
    expect(await (await repos()).trainingMax.getTrainingMaxes('rpt')).toEqual([]);
    expect((await stored()).filter((s) => s.notes === '1RM test')).toEqual([expect.objectContaining({ weight: 315 })]);
  });

  it("keeps a flag-off commit's rows out of an imported macrocycle with their number", async () => {
    const rows = run(RPT_DAYS, 0, 3);
    await commit(csvOf(rows), breakdownOf([stretch(rows)]));
    const [imported] = await macrocycles();
    expect(imported?.origin).toBe('imported');

    delete process.env[FLAG];
    const num = imported?.macrocycleNum ?? 0;
    const later = [{ day: 40, lift: 'Squat', program: 'rpt', macrocycle: num, workout: 1 }];
    const res = await importCsv('rpt', csvOf(later), '?mode=commit&destination=lift-records');
    expect(res.statusCode).toBe(200);
    expect(res.json<ImportCommitResponse>().created).toBe(1);

    const after = await macrocycles();
    const importedNow = after.find((m) => m.id === imported?.id);
    const bundle = await repos();
    const inImported = await bundle.liftRecord.getLiftRecords('rpt', importedNow?.macrocycleNum ?? -1);
    expect(inImported).toHaveLength(9);
    expect(inImported.some((s) => ymd(s.date) === day(40))).toBe(false);
    expect((await stored()).filter((s) => ymd(s.date) === day(40))).toHaveLength(1);
  });

  describe('a breakdown that does not match the file', () => {
    const rows = [...run(RPT_DAYS, 0, 3), ...run(RPT_DAYS, 30, 3)];
    const first = rows.filter((r) => (r.day ?? 0) < 30);
    const second = rows.filter((r) => (r.day ?? 0) >= 30);
    const cases: Array<[string, ImportBreakdown]> = [
      ['leaves a session out', breakdownOf([stretch(first)])],
      ['names a date with no session', breakdownOf([stretch(first), { ...stretch(second), dates: [...datesOf(second), day(99)] }])],
      ['puts a date in two places', breakdownOf([stretch(first), stretch(second)], { excludedDates: [day(0)] })],
      // Days 0 and 4 in one stretch, day 2 with the later sessions.
      ['has stretches that overlap', breakdownOf([{ ...stretch(first), dates: [day(0), day(4)] }, { ...stretch(second), dates: [day(2), ...datesOf(second)] }])],
      ['names a program the lifter lacks', breakdownOf([stretch(first), stretch(second, 'no-such-program')])],
      ['names a file macrocycle in a file that is not an export', breakdownOf([stretch(first), { program: 'rpt', file: { group: 'rpt', macrocycleNum: 1 }, status: 'completed', statusChosen: false }])],
    ];

    it.each(cases)('is rejected with nothing written when it %s', async (_name, breakdown) => {
      for (const mode of ['dry-run', 'commit'] as const) {
        const res = await send(mode, csvOf(rows), breakdown);
        expect(res.statusCode).toBe(400);
        expect(res.json<{ code: string }>().code).toBe('breakdown-mismatch');
      }
      expect(await counts()).toEqual({ sets: 0, macrocycles: 0 });
    });
  });

  it('adds zero rows on a re-import, after a changed breakdown or a changed program', async () => {
    const rows = [...run(RPT_DAYS, 0, 6), ...run(RPT_DAYS, 40, 3)];
    const csv = csvOf(rows);
    const first = rows.filter((r) => (r.day ?? 0) < 40);
    const second = rows.filter((r) => (r.day ?? 0) >= 40);
    await commit(csv, breakdownOf([stretch(first), stretch(second)]));
    const before = await counts();
    expect(before).toEqual({ sets: 27, macrocycles: 2 });

    const again = await commit(csv, breakdownOf([stretch(first), stretch(second)]));
    expect(again).toMatchObject({ created: 0, skipped: 27 });
    // Nothing written, so no lift is listed (#1273).
    expect(again.lifts).toEqual([]);
    expect(again.assigned?.macrocycles).toBe(0);

    // The first stretch split in two, then everything under 5/3/1.
    const early = first.filter((r) => (r.day ?? 0) < 6);
    const late = first.filter((r) => (r.day ?? 0) >= 6);
    expect((await commit(csv, breakdownOf([stretch(early), stretch(late), stretch(second)]))).created).toBe(0);
    expect((await commit(csv, breakdownOf([stretch(first, '5-3-1'), stretch(second, '5-3-1')]))).created).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it('keeps two workouts on one date, re-imports nothing, and survives undoing an earlier batch', async () => {
    // Two workouts on day 0 that repeat a set: the file's workout numbers keep them apart.
    const sameDay: Row[] = [
      { day: 0, lift: 'Squat', workout: 1, weight: 200 },
      { day: 0, lift: 'Squat', workout: 2, weight: 200 },
      { day: 0, lift: 'Bench Press', workout: 2, weight: 150 },
    ];
    const firstBatch = await commit(csvOf(sameDay), breakdownOf([stretch(sameDay)]));
    expect(firstBatch.created).toBe(3);
    expect(await stored()).toHaveLength(3);
    expect((await commit(csvOf(sameDay), breakdownOf([stretch(sameDay)]))).created).toBe(0);

    // A later file holds the same day and the next session.
    const grown: Row[] = [...sameDay, { day: 2, lift: 'Deadlift', workout: 3, weight: 300 }];
    expect((await commit(csvOf(grown), breakdownOf([stretch(grown)]))).created).toBe(1);
    expect(await stored()).toHaveLength(4);

    await undo(firstBatch.batchId);
    expect((await stored()).map((s) => s.lift)).toEqual(['deadlift']);

    expect((await commit(csvOf(grown), breakdownOf([stretch(grown)]))).created).toBe(3);
    const sets = await stored();
    expect(sets).toHaveLength(4);
    expect(sets.filter((s) => s.lift === 'back-squat').map((s) => s.workoutNum).sort()).toEqual([1, 2]);
  });

  it('matches a lift id with its name, skips an exact repeat, and counts a changed row in the dry run', async () => {
    const rows: Row[] = [
      { day: 0, lift: 'Bench Press', weight: 100 },
      { day: 2, lift: 'Squat', weight: 200 },
    ];
    await commit(csvOf(rows), breakdownOf([stretch(rows)]));

    const respelled: Row[] = [{ day: 0, lift: 'bench-press', weight: 100 }];
    expect((await dryRun(csvOf(respelled), breakdownOf([stretch(respelled)]))).created).toBe(0);

    // Day 4's set appears twice; day 2's Squat is now 205.
    const repeat: Row[] = [
      { day: 4, lift: 'Deadlift', weight: 300 },
      { day: 4, lift: 'Deadlift', weight: 300 },
      { day: 2, lift: 'Squat', weight: 205 },
    ];
    const breakdown = breakdownOf([stretch(repeat)]);
    const dry = await dryRun(csvOf(repeat), breakdown);
    expect(dry).toMatchObject({ created: 1, skipped: 2 });
    expect(dry.assigned?.changed).toBe(1);

    const body = await commit(csvOf(repeat), breakdown);
    expect(body).toMatchObject({ created: 1, skipped: 2 });
    expect(body.skippedDetail).toHaveLength(2);
    const sets = await stored();
    expect(sets.filter((s) => s.lift === 'deadlift')).toHaveLength(1);
    expect(sets.find((s) => s.lift === 'back-squat')?.weight).toBe(200);
  });

  it('stores a stretch whose file number is in use under the number its date gives it', async () => {
    const older = run(RPT_DAYS, 0, 3);
    await commit(csvOf(older), breakdownOf([stretch(older)]));
    const [first] = await macrocycles();
    expect(first?.macrocycleNum).toBe(1);

    // The newer stretch's file says macrocycle 1 too.
    const newer = run(RPT_DAYS, 30, 3, { program: 'rpt', macrocycle: 1 });
    await commit(csvOf(newer), breakdownOf([stretch(newer)]));
    const rows = await macrocycles();
    expect(rows.map((m) => [m.macrocycleNum, ymd(m.startDate)])).toEqual([
      [1, day(0)],
      [2, day(30)],
    ]);
    const bundle = await repos();
    expect((await bundle.liftRecord.getLiftRecords('rpt', 1)).map((s) => ymd(s.date))).not.toContain(day(30));
    expect(await bundle.liftRecord.getLiftRecords('rpt', 2)).toHaveLength(9);
  });

  it('keeps numbers in date order around a live macrocycle, and undo puts them back', async () => {
    const page = (method: string, url: string, body: unknown) =>
      injectPage(app, {
        method: method as 'POST',
        url,
        headers: { 'content-type': 'application/json', ...auth() },
        payload: JSON.stringify(body),
      });
    const init = await page('POST', '/programs/rpt/macrocycles/initialize', { macrocycleDate: day(100) });
    expect(init.statusCode).toBe(201);
    const live = (await macrocycles())[0];
    expect(live).toMatchObject({ macrocycleNum: 1, origin: 'live' });

    const rows = run(RPT_DAYS, 0, 3);
    const body = await commit(csvOf(rows), breakdownOf([stretch(rows)]));
    expect((await macrocycles()).map((m) => [m.macrocycleNum, m.origin])).toEqual([
      [1, 'imported'],
      [2, 'live'],
    ]);

    const next = await page('POST', '/programs/rpt/macrocycles', { macrocycleDate: day(150) });
    expect(next.statusCode).toBe(201);
    expect(next.json<{ macrocycleNum: number }>().macrocycleNum).toBe(3);

    await undo(body.batchId);
    const after = await macrocycles();
    expect(after.map((m) => m.macrocycleNum)).toEqual([1, 2]);
    expect(after[0]?.id).toBe(live?.id);
  });

  it('leaves rows with no date out, counts them, and commits the rest', async () => {
    const rows = [...run(RPT_DAYS, 0, 3), { day: null, lift: 'Squat' }, { day: null, lift: 'Dips' }];
    const body = await commit(csvOf(rows), breakdownOf([stretch(rows)]));
    expect(body.created).toBe(9);
    expect(body.assigned?.undatedRows).toBe(2);
    expect(await stored()).toHaveLength(9);
  });

  it('leaves training maxes alone apart from split rows, which go to the program covering their date', async () => {
    const bundle = await repos();
    const maxDate = new Date(`${day(100)}T00:00:00Z`);
    await bundle.trainingMax.saveTrainingMaxes('rpt', [{ lift: 'back-squat', weight: 300, dateUpdated: maxDate }]);

    // Two stretches with a 26-day break and no one-rep-max rows: no max changes.
    const plain = [...run(RPT_DAYS, 0, 3), ...run(RPT_DAYS, 30, 3)];
    await commit(
      csvOf(plain),
      breakdownOf([stretch(plain.filter((r) => (r.day ?? 0) < 30)), stretch(plain.filter((r) => (r.day ?? 0) >= 30))]),
    );
    expect(await bundle.trainingMax.getTrainingMaxes('rpt')).toEqual([expect.objectContaining({ lift: 'back-squat', weight: 300 })]);
    expect(await bundle.trainingMax.getTrainingMaxes('5-3-1')).toEqual([]);

    // 5/3/1 then RPT, each with a one-rep-max row inside its stretch. RPT's max is newer than its row.
    const fiveThreeOne = run(FIVE_THREE_ONE_DAYS, 60, 6);
    const rpt = run(RPT_DAYS, 74, 6);
    const rows = [
      ...fiveThreeOne,
      { day: 65, lift: 'Squat', notes: '1RM test', weight: 315 },
      ...rpt,
      { day: 79, lift: 'Squat', notes: '1RM test', weight: 320 },
    ];
    const body = await commit(csvOf(rows), breakdownOf([stretch(fiveThreeOne, '5-3-1'), stretch(rpt)]), '&splitDest=1');
    expect(body.assigned?.splitOlderThanCurrent).toBe(1);
    expect(body.split).toMatchObject({ created: 1, skipped: 1 });
    expect(await bundle.trainingMax.getTrainingMaxes('5-3-1')).toEqual([
      expect.objectContaining({ lift: 'back-squat', weight: 315 }),
    ]);
    expect(await bundle.trainingMax.getTrainingMaxes('rpt')).toEqual([expect.objectContaining({ lift: 'back-squat', weight: 300 })]);

    // The 5/3/1 max is undone with the rest of the import, its sets, and its emptied macrocycle.
    const fiveThreeOneNums = (await macrocycles('5-3-1')).map((m) => m.macrocycleNum);
    expect(fiveThreeOneNums).toHaveLength(1);
    await undo(body.batchId);
    expect(await bundle.trainingMax.getTrainingMaxes('5-3-1')).toEqual([]);
    expect(await macrocycles('5-3-1')).toEqual([]);
    for (const n of fiveThreeOneNums) expect(await bundle.liftRecord.getLiftRecords('5-3-1', n)).toEqual([]);
  });

  it('stores a lone session as a non-cycle workout, and undoes it', async () => {
    const first = run(RPT_DAYS, 0, 3);
    const lone: Row[] = [{ day: 19, lift: 'Bench Press' }];
    const second = run(RPT_DAYS, 34, 3);
    const rows = [...first, ...lone, ...second];
    const breakdown = breakdownOf([stretch(first), stretch(second)], { nonCycleDates: [day(19)] });

    const body = await commit(csvOf(rows), breakdown);
    expect(body.created).toBe(19);
    expect(body.assigned).toMatchObject({ macrocycles: 2, nonCycleSessions: 1 });
    const nonCycle = await stored('non-cycle');
    expect(nonCycle).toEqual([expect.objectContaining({ program: 'non-cycle', lift: 'bench-press' })]);
    expect((await stored()).some((s) => ymd(s.date) === day(19))).toBe(false);
    expect((await macrocycles()).map((m) => [ymd(m.startDate), m.endDate && ymd(m.endDate)])).toEqual([
      [day(0), day(4)],
      [day(34), day(38)],
    ]);
    expect(await (await repos()).trainingMax.getTrainingMaxes('rpt')).toEqual([]);

    expect((await commit(csvOf(rows), breakdown)).created).toBe(0);

    await undo(body.batchId);
    // Read by number, so a set left behind without its macrocycle row would show.
    expect(await (await repos()).liftRecord.getLiftRecords('non-cycle', NON_CYCLE_MACROCYCLE_NUM)).toEqual([]);
    expect(await counts()).toEqual({ sets: 0, macrocycles: 0 });
  });

  it('keeps two non-cycle sets apart that the file told apart only by macrocycle number', async () => {
    const first = run(RPT_DAYS, 0, 3);
    // One date, one workout number, the same set: one row in Cycle # 1, the other blank.
    const lone: Row[] = [
      { day: 19, lift: 'Squat', macrocycle: 1, workout: 3, weight: 200 },
      { day: 19, lift: 'Squat', workout: 3, weight: 210 },
    ];
    const csv = csvOf([...first, ...lone]);
    const breakdown = breakdownOf([stretch(first)], { nonCycleDates: [day(19)] });

    expect((await dryRun(csv, breakdown)).created).toBe(11);
    expect((await commit(csv, breakdown)).created).toBe(11);
    expect((await stored('non-cycle')).map((s) => s.weight).sort()).toEqual([200, 210]);
    expect((await commit(csv, breakdown)).created).toBe(0);
  });

  it("rejects a date stretch that takes an export's sessions from the stretch naming them", async () => {
    const one = run(RPT_DAYS, 0, 3, { program: 'rpt', macrocycle: 1 });
    // A session the lifter added to the export, with no Program or Cycle #.
    const added: Row[] = [{ day: 10, lift: 'Squat' }];
    const csv = csvOf([...one, ...added], ['Occurrence']);
    const byFile: ImportBreakdownStretch = { program: 'rpt', file: { group: 'rpt', macrocycleNum: 1 }, status: 'completed', statusChosen: false };

    const res = await send('commit', csv, breakdownOf([byFile, { ...stretch(added), dates: [day(4), day(10)] }]));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string; message: string }>()).toMatchObject({
      code: 'breakdown-mismatch',
      message: expect.stringContaining(day(4)),
    });
    expect(await counts()).toEqual({ sets: 0, macrocycles: 0 });

    // The added session takes the number above it, so Assign groups it in macrocycle 1 (#1256):
    // a date stretch can't take it either, and the file stretch stores it.
    expect((await send('commit', csv, breakdownOf([byFile, stretch(added)]))).statusCode).toBe(400);
    expect((await commit(csv, breakdownOf([byFile]))).created).toBe(10);
  });

  /** `mode=assign`'s stretches for `csv`. */
  const assignOf = async (csv: string) => {
    const res = await importCsv('rpt', csv, '?mode=assign&destination=lift-records');
    expect(res.statusCode).toBe(200);
    return res.json<ImportAssignResponse>();
  };

  it("pairs an export's rows as Assign grouped them, blank and differently spelled Program cells included (#1256)", async () => {
    const rows = run(RPT_DAYS, 0, 3, { program: 'rpt', macrocycle: 1 }).map((r, i) =>
      i === 1 ? { ...r, program: '' } : i === 4 ? { ...r, program: 'RPT' } : r,
    );
    const csv = csvOf(rows, ['Occurrence']);
    const [only] = (await assignOf(csv)).stretches;
    expect(only).toMatchObject({ fileMacrocycleNum: 1, fileGroup: 'rpt' });
    const file = { group: only?.fileGroup ?? '', macrocycleNum: 1 };
    expect((await commit(csv, breakdownOf([{ program: 'rpt', file, status: 'completed', statusChosen: false }]))).created).toBe(9);
  });

  it("keeps an export's numbered rows on a day whose unnumbered session is left out (#1256)", async () => {
    // A 5-3-1 row with no number to take, on a day the rpt macrocycle also trained.
    const stray: Row = { day: 2, lift: 'Deadlift', program: '5-3-1' };
    const csv = csvOf([stray, ...run(RPT_DAYS, 0, 3, { program: 'rpt', macrocycle: 1 })], ['Occurrence']);
    const assigned = await assignOf(csv);
    expect(assigned.unnumbered.map((s) => s.date)).toEqual([day(2)]);
    const byFile: ImportBreakdownStretch = { program: 'rpt', file: { group: 'rpt', macrocycleNum: 1 }, status: 'completed', statusChosen: false };
    expect((await commit(csv, breakdownOf([byFile], { excludedDates: [day(2)] }))).created).toBe(9);
  });

  it("puts an unnumbered row on a stretch's day into that stretch, in a file that isn't an export (#1256)", async () => {
    // The same file without the export's columns: placed by date, so day 2's rows all go with rpt.
    const stray: Row = { day: 2, lift: 'Deadlift', program: '5-3-1' };
    const csv = csvOf([stray, ...run(RPT_DAYS, 0, 3, { program: 'rpt', macrocycle: 1 })]);
    const assigned = await assignOf(csv);
    expect(assigned.exported).toBe(false);
    expect(assigned.unnumbered).toEqual([]);
    const [only] = assigned.stretches;
    expect(assigned.stretches).toHaveLength(1);
    expect(only?.sessions.find((s) => s.date === day(2))?.lifts).toContain('Deadlift');

    const dates = only?.sessions.map((s) => s.date) ?? [];
    const result = await commit(csv, breakdownOf([{ program: 'rpt', dates, status: 'completed', statusChosen: false }]));
    expect(result.created).toBe(10);
  });

  it("counts a row joined to its day's macrocycle toward its program, under the day's workout number (#1256)", async () => {
    // Barbell Row isn't a 5/3/1 lift, and this file numbers 5/3/1's workouts from 5.
    const fiveThreeOne = run(FIVE_THREE_ONE_DAYS, 0, 3, { program: '5-3-1', macrocycle: 1 }).map((r) => ({
      ...r,
      workout: (r.day ?? 0) / 2 + 5,
    }));
    const csv = csvOf([...fiveThreeOne, { day: 2, lift: 'Barbell Row', program: 'rpt' }]);
    const assigned = await assignOf(csv);
    expect(assigned.unnumbered).toEqual([]);
    const [only] = assigned.stretches;
    expect(only).toMatchObject({ matched: false, liftsOutsideProgram: ['Barbell Row'] });
    expect(only?.sessions.find((s) => s.date === day(2))).toMatchObject({ workoutNum: 6 });

    const dates = only?.sessions.map((s) => s.date) ?? [];
    await commit(csv, breakdownOf([{ program: '5-3-1', dates, status: 'completed', statusChosen: true }]));
    expect(await macrocycles('5-3-1')).toEqual([expect.objectContaining({ unmatched: true })]);
    const onDay2 = (await stored('5-3-1')).filter((r) => ymd(new Date(r.date)) === day(2));
    expect(onDay2.map((r) => r.workoutNum)).toEqual([6, 6, 6]);
  });

  it('refuses to undo a batch grouped under another one', async () => {
    const fiveThreeOne = run(FIVE_THREE_ONE_DAYS, 0, 2);
    const rpt = run(RPT_DAYS, 20, 2);
    const { batchId } = await commit(csvOf([...fiveThreeOne, ...rpt]), breakdownOf([stretch(fiveThreeOne, '5-3-1'), stretch(rpt)]));
    const grouped = await (await repos()).importBatch.listGroup(batchId ?? '');
    expect(grouped.map((b) => b.program)).toEqual(['5-3-1']);

    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/programs/5-3-1/import/${grouped[0]?.id}/undo`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(await stored('5-3-1')).toHaveLength(4);

    // Once the Source batch is gone, as a revision from before #1254 leaves it, the grouped one undoes alone.
    await (await repos()).importBatch.deleteById(batchId ?? '', user);
    await undo(grouped[0]?.id ?? null, '5-3-1');
    expect(await stored('5-3-1')).toEqual([]);
    expect(await stored('rpt')).toHaveLength(6);
  });

  it('logs counts only', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    try {
      const rows = [...run(RPT_DAYS, 0, 3), { day: 19, lift: 'Bench Press' }, ...run(RPT_DAYS, 34, 3)];
      const breakdown = breakdownOf(
        [stretch(rows.filter((r) => (r.day ?? 0) < 19)), stretch(rows.filter((r) => (r.day ?? 0) > 19))],
        { excludedDates: [day(19)] },
      );
      await commit(csvOf(rows), breakdown);
      const call = log.mock.calls.find(([, message]) => message === 'Import breakdown (#1254)');
      expect(call?.[0]).toEqual(
        expect.objectContaining({
          mode: 'commit',
          stretches: 2,
          macrocycles: 2,
          excludedSessions: 1,
          created: 18,
          duplicates: 0,
          changed: 0,
        }),
      );
      expect(JSON.stringify(call?.[0])).not.toMatch(/Bench|Squat|Press|bench|squat/);
    } finally {
      log.mockRestore();
    }
  });

  it('refuses a breakdown with the flag off, or for another destination', async () => {
    const rows = run(RPT_DAYS, 0, 1);
    const breakdown = JSON.stringify(breakdownOf([stretch(rows)]));
    const other = await importCsv('rpt', 'Date Updated,Lift,Weight\n2026-01-01,Squat,300', '?mode=commit&destination=training-maxes', { breakdown });
    expect(other.statusCode).toBe(400);
    expect(other.json<{ message: string }>().message).toMatch(/destination=lift-records/);
    delete process.env[FLAG];
    const off = await importCsv('rpt', csvOf(rows), '?mode=commit&destination=lift-records', { breakdown });
    expect(off.statusCode).toBe(400);
    expect(off.json<{ message: string }>().message).toMatch(/Assign step/);
    expect(await counts()).toEqual({ sets: 0, macrocycles: 0 });
  });

  it('gives a commit a 409, writing nothing, while another import holds the lock', async () => {
    const rows = run(RPT_DAYS, 0, 3);
    const inMemory = (await repos()).macrocycle;
    if (!(inMemory instanceof InMemoryMacrocycleRepository)) throw new Error('expected the in-memory macrocycle adapter');
    inMemory.importLockHeld = true;
    try {
      const res = await send('commit', csvOf(rows), breakdownOf([stretch(rows)]));
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('import-in-progress');
      // A dry run writes nothing, so it takes no lock.
      expect((await dryRun(csvOf(rows), breakdownOf([stretch(rows)]))).created).toBe(9);
    } finally {
      inMemory.importLockHeld = false;
    }
    expect(await counts()).toEqual({ sets: 0, macrocycles: 0 });
  });

  it('logs a mismatch by its reason alone', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      const rows = [...run(RPT_DAYS, 0, 3), ...run(RPT_DAYS, 30, 3)];
      const res = await send('commit', csvOf(rows), breakdownOf([stretch(rows.filter((r) => (r.day ?? 0) < 30))]));
      expect(res.json<{ reason: string }>().reason).toBe('sessions-left-out');
      const call = warn.mock.calls.find(([, message]) => message === 'Import breakdown mismatch (#1254)');
      expect(call?.[0]).toEqual({ mode: 'commit', reason: 'sessions-left-out', stretches: 1 });
    } finally {
      warn.mockRestore();
    }
  });

  it("doesn't split an export committed with no breakdown while the flag is on", async () => {
    const rows = [
      ...run(RPT_DAYS, 0, 3, { program: 'rpt', macrocycle: 1 }),
      { day: 5, lift: 'Squat', program: 'rpt', macrocycle: 1, notes: '1RM test', weight: 315 },
    ].map((r) => ({ ...r, workout: Math.floor((r.day ?? 0) / 2) + 1 }));
    const res = await importCsv('rpt', csvOf(rows, ['Occurrence']), '?mode=commit&destination=lift-records&splitDest=1');
    expect(res.statusCode).toBe(200);
    expect(res.json<ImportCommitResponse>()).toMatchObject({ created: 10 });
    expect(res.json<ImportCommitResponse>().split).toBeUndefined();
    expect(await (await repos()).trainingMax.getTrainingMaxes('rpt')).toEqual([]);
  });

  describe('a file that has grown (#1255, decision 14)', () => {
    const assign = async (csv: string, program = 'rpt') => {
      const res = await importCsv(program, csv, '?mode=assign&destination=lift-records');
      expect(res.statusCode).toBe(200);
      return res.json<ImportAssignResponse>();
    };
    const at = (n: number) => new Date(`${day(n)}T00:00:00Z`);
    const inProgress = { status: 'in-progress', statusChosen: false } as const;

    it('extends its macrocycle: new rows take its number and workouts, and its end date moves', async () => {
      const first = run(RPT_DAYS, 0, 3);
      await commit(csvOf(first), breakdownOf([stretch(first, 'rpt', inProgress)]));
      const [before] = await macrocycles();

      const grown = run(RPT_DAYS, 0, 6);
      const placed = await assign(csvOf(grown));
      expect(placed.stretches.map((s) => s.stored)).toEqual([
        { kind: 'joins', macrocycleNum: before?.macrocycleNum, newWorkouts: 3 },
      ]);
      const preview = await dryRun(csvOf(grown), breakdownOf([stretch(grown, 'rpt', inProgress)]));
      expect(preview.assigned).toMatchObject({ macrocycles: 0, extended: 1 });

      const body = await commit(csvOf(grown), breakdownOf([stretch(grown, 'rpt', inProgress)]));
      expect(body).toMatchObject({ created: 9, skipped: 9 });
      expect(body.assigned).toMatchObject({ macrocycles: 0, extended: 1 });
      const [after, ...others] = await macrocycles();
      expect(others).toEqual([]);
      expect(after).toMatchObject({ id: before?.id, macrocycleNum: before?.macrocycleNum, startDate: at(0), endDate: at(10) });
      const sets = await stored();
      expect(sets).toHaveLength(18);
      expect(new Set(sets.map((s) => s.macrocycleNum))).toEqual(new Set([before?.macrocycleNum]));
      // No file numbers: the new sessions continue from the stored run's highest workout.
      expect([...new Set(sets.filter((s) => s.date >= at(6)).map((s) => s.workoutNum))].sort()).toEqual([4, 5, 6]);
    });

    it('extends a run from a file holding only the sessions after it, within 14 days', async () => {
      const first = run(RPT_DAYS, 0, 3);
      await commit(csvOf(first), breakdownOf([stretch(first, 'rpt', inProgress)]));
      const later = run(RPT_DAYS, 14, 2);
      expect((await assign(csvOf(later))).stretches.map((s) => s.stored.kind)).toEqual(['joins']);
      await commit(csvOf(later), breakdownOf([stretch(later, 'rpt', inProgress)]));
      expect(await macrocycles()).toEqual([expect.objectContaining({ startDate: at(0), endDate: at(16) })]);
    });

    it("doesn't extend a finished run, a run 15 days back, or one the file's workout numbers restart", async () => {
      const finished = run(RPT_DAYS, 0, 3);
      await commit(csvOf(finished), breakdownOf([stretch(finished, 'rpt', { status: 'completed', statusChosen: true })]));
      const after = run(RPT_DAYS, 6, 2);
      expect((await assign(csvOf(after))).stretches.map((s) => s.stored)).toEqual([{ kind: 'new' }]);
      await commit(csvOf(after), breakdownOf([stretch(after, 'rpt', inProgress)]));
      expect((await macrocycles()).map((m) => [m.startDate, m.endDate])).toEqual([
        [at(0), at(4)],
        [at(6), at(8)],
      ]);

      // 15 days after the last session is a break (decision 4).
      const stale = run(RPT_DAYS, 23, 1);
      expect((await assign(csvOf(stale))).stretches.map((s) => s.stored.kind)).toEqual(['new']);

      // Workout 1 again after workout 2 is a restart (decision 7).
      user = `${user}-restart`;
      const numbered = run(RPT_DAYS, 0, 2).map((r) => ({ ...r, workout: (r.day ?? 0) / 2 + 1 }));
      await commit(csvOf(numbered), breakdownOf([stretch(numbered, 'rpt', inProgress)]));
      const restart = run(RPT_DAYS, 6, 1).map((r) => ({ ...r, workout: 1 }));
      expect((await assign(csvOf(restart))).stretches.map((s) => s.stored.kind)).toEqual(['new']);
    });

    it('reads a stretch with nothing new as already imported, and writes nothing for it', async () => {
      const rows = run(RPT_DAYS, 0, 3);
      await commit(csvOf(rows), breakdownOf([stretch(rows, 'rpt', inProgress)]));
      expect((await assign(csvOf(rows))).stretches.map((s) => s.stored)).toEqual([{ kind: 'already-imported' }]);
      const again = await commit(csvOf(rows), breakdownOf([stretch(rows, 'rpt', inProgress)]));
      expect(again).toMatchObject({ created: 0, assigned: { macrocycles: 0, extended: 0 } });
    });

    it('forms its own macrocycle over another program, and says the dates overlap', async () => {
      const fiveThreeOne = run(FIVE_THREE_ONE_DAYS, 0, 4);
      await commit(csvOf(fiveThreeOne), breakdownOf([stretch(fiveThreeOne, '5-3-1', inProgress)]));
      const [other] = await macrocycles('5-3-1');
      // RPT sessions on the days between 5/3/1's.
      const rpt = run(RPT_DAYS, 1, 3);
      expect((await assign(csvOf(rpt))).stretches.map((s) => s.stored)).toEqual([
        { kind: 'overlaps', macrocycles: [{ program: '5-3-1', macrocycleNum: other?.macrocycleNum }] },
      ]);
      const body = await commit(csvOf(rpt), breakdownOf([stretch(rpt, 'rpt', inProgress)]));
      expect(body.assigned).toMatchObject({ macrocycles: 1, extended: 0 });
      expect(await macrocycles('rpt')).toEqual([expect.objectContaining({ startDate: at(1), endDate: at(5) })]);
      expect(await macrocycles('5-3-1')).toEqual([expect.objectContaining({ id: other?.id, startDate: at(0), endDate: at(6) })]);
    });

    it('undoes three batches out of order on a two-program file, recomputing what remains', async () => {
      const before = await counts();
      // Recent dates, so statuses turn on what follows each run, not on its age: day 200 is today.
      // 5/3/1 every other day from day 166, then RPT every other day from day 186; each file grows
      // by two sessions of each.
      const file = (sessions: number) => [...run(FIVE_THREE_ONE_DAYS, 166, sessions), ...run(RPT_DAYS, 186, sessions)];
      const breakdown = (rows: Row[], chosen: boolean) =>
        breakdownOf([
          stretch(rows.filter((r) => (r.day ?? 0) < 186), '5-3-1', chosen ? { status: 'overran', statusChosen: true } : inProgress),
          stretch(rows.filter((r) => (r.day ?? 0) >= 186), 'rpt', inProgress),
        ]);
      const commitFile = async (sessions: number, chosen: boolean) => {
        const body = await commit(csvOf(file(sessions)), breakdown(file(sessions), chosen));
        expect(body.assigned).toMatchObject(sessions === 3 ? { macrocycles: 2, extended: 0 } : { macrocycles: 0, extended: 2 });
        return body.batchId;
      };
      const firstBatch = await commitFile(3, true);
      const secondBatch = await commitFile(5, false);
      const thirdBatch = await commitFile(7, false);
      const span = async (program: string) => (await macrocycles(program)).map((m) => [m.startDate, m.endDate, m.status]);
      expect(await counts()).toEqual({ sets: 7 * 3 + 7 * 2, macrocycles: 2 });
      expect(await span('5-3-1')).toEqual([[at(166), at(178), 'overran']]);
      expect(await span('rpt')).toEqual([[at(186), at(198), 'in-progress']]);

      // The middle batch: both runs keep their dates, from the rows on either side of the gap.
      await undo(secondBatch);
      expect(await counts()).toEqual({ sets: 5 * 3 + 5 * 2, macrocycles: 2 });
      expect(await span('5-3-1')).toEqual([[at(166), at(178), 'overran']]);
      expect(await span('rpt')).toEqual([[at(186), at(198), 'in-progress']]);

      // The first batch: what's left starts where the last batch's rows do. The status the first
      // batch chose goes with it, so 5/3/1's is read again from its rows: RPT follows it, so abandoned.
      await undo(firstBatch);
      expect(await counts()).toEqual({ sets: 2 * 3 + 2 * 2, macrocycles: 2 });
      expect(await span('5-3-1')).toEqual([[at(176), at(178), 'abandoned']]);
      expect(await span('rpt')).toEqual([[at(196), at(198), 'in-progress']]);
      expect((await stored('5-3-1')).map((s) => s.date)).toEqual(expect.arrayContaining([at(176), at(178)]));

      // The last batch: nothing is left, so both macrocycles go.
      await undo(thirdBatch);
      expect(await counts()).toEqual(before);
    });

    it("reads a joined run's status against what follows it once the import, or its undo, is written", async () => {
      // Recent dates, so a run's status turns on what follows it, not on its age: day 200 is today.
      const first = run(RPT_DAYS, 186, 3);
      await commit(csvOf(first), breakdownOf([stretch(first, 'rpt', inProgress)]));
      const grown = run(RPT_DAYS, 186, 5);
      const fiveThreeOne = run(FIVE_THREE_ONE_DAYS, 196, 2);
      const body = await commit(
        csvOf([...grown, ...fiveThreeOne]),
        breakdownOf([stretch(grown, 'rpt', inProgress), stretch(fiveThreeOne, '5-3-1', inProgress)]),
      );
      expect(body.assigned).toMatchObject({ macrocycles: 1, extended: 1 });
      const span = async (program: string) => (await macrocycles(program)).map((m) => [m.startDate, m.endDate, m.status]);
      // The 5/3/1 run this import created follows the RPT run it extended.
      expect(await span('rpt')).toEqual([[at(186), at(194), 'abandoned']]);

      // Undo takes the lifter's day, as the commit does, and refuses one that isn't a date.
      expect((await undoRequest(body.batchId, 'rpt', '2026-02-30')).statusCode).toBe(400);
      expect(await span('rpt')).toEqual([[at(186), at(194), 'abandoned']]);
      // With the 5/3/1 run gone, nothing follows RPT's last session, 10 days ago.
      await undo(body.batchId, 'rpt', day(200));
      expect(await span('rpt')).toEqual([[at(186), at(190), 'in-progress']]);
      expect(await macrocycles('5-3-1')).toEqual([]);
    });

    it("gives a new set on a date the run already holds that date's workout", async () => {
      const first = run(RPT_DAYS, 0, 3);
      await commit(csvOf(first), breakdownOf([stretch(first, 'rpt', inProgress)]));
      const [before] = await macrocycles();
      // An accessory added to the second session after the first export, and a fourth session.
      const grown = [...run(RPT_DAYS, 0, 4), { day: 2, lift: 'Face Pull' }];
      expect((await assign(csvOf(grown))).stretches.map((s) => s.stored)).toEqual([
        { kind: 'joins', macrocycleNum: before?.macrocycleNum, newWorkouts: 1 },
      ]);
      await commit(csvOf(grown), breakdownOf([stretch(grown, 'rpt', inProgress)]));
      const workoutsOn = async (n: number) =>
        [...new Set((await stored()).filter((s) => s.date.getTime() === at(n).getTime()).map((s) => s.workoutNum))];
      expect(await workoutsOn(2)).toEqual([2]);
      expect(await workoutsOn(6)).toEqual([4]);
    });

    it('puts back the status, chosen flag and unmatched flag a join wrote when its batch is undone', async () => {
      const first = run(RPT_DAYS, 0, 3);
      await commit(csvOf(first), breakdownOf([stretch(first, 'rpt', inProgress)]));
      const [before] = await macrocycles();
      expect(before).toMatchObject({ statusChosen: false, unmatched: false });
      // A lift RPT doesn't have, and a status the lifter chose.
      const grown = [...run(RPT_DAYS, 0, 4), { day: 6, lift: 'Face Pull' }];
      const body = await commit(csvOf(grown), breakdownOf([stretch(grown, 'rpt', { status: 'overran', statusChosen: true })]));
      expect(await macrocycles()).toEqual([
        expect.objectContaining({ id: before?.id, status: 'overran', statusChosen: true, unmatched: true }),
      ]);

      await undo(body.batchId);
      // Its status is read again from its rows, from 200 days back: abandoned.
      expect(await macrocycles()).toEqual([
        expect.objectContaining({ id: before?.id, startDate: at(0), endDate: at(4), status: 'abandoned', statusChosen: false, unmatched: false }),
      ]);
    });

    it('ends where it started when two joins that chose statuses are undone, in either order', async () => {
      for (const order of ['first', 'second'] as const) {
        user = `${user}-${order}`;
        // Recent dates, so the run left at the end reads as in progress, not abandoned.
        const seed = run(RPT_DAYS, 186, 2);
        await commit(csvOf(seed), breakdownOf([stretch(seed, 'rpt', inProgress)]));
        const [start] = await macrocycles();
        expect(start).toMatchObject({ status: 'in-progress', statusChosen: false, unmatched: false });

        // Each join adds a session and chooses a status; the first adds a lift RPT doesn't have.
        const join = async (sessions: number, status: 'overran' | 'abandoned') => {
          const rows = [...run(RPT_DAYS, 186, sessions), { day: 190, lift: 'Face Pull' }];
          const body = await commit(csvOf(rows), breakdownOf([stretch(rows, 'rpt', { status, statusChosen: true })]));
          expect(body.assigned).toMatchObject({ macrocycles: 0, extended: 1 });
          return body.batchId;
        };
        const first = await join(3, 'overran');
        const second = await join(4, 'abandoned');
        expect(await macrocycles()).toEqual([
          expect.objectContaining({ id: start?.id, status: 'abandoned', statusChosen: true, unmatched: true }),
        ]);

        for (const batchId of order === 'first' ? [first, second] : [second, first]) await undo(batchId);
        expect(await macrocycles()).toEqual([
          expect.objectContaining({
            id: start?.id,
            startDate: at(186),
            endDate: at(188),
            status: 'in-progress',
            statusChosen: false,
            unmatched: false,
          }),
        ]);
      }
    });

    it('recomputes a run that a batch saved before #1255 created, once a later import extended it', async () => {
      const first = run(RPT_DAYS, 0, 3);
      const { batchId } = await commit(csvOf(first), breakdownOf([stretch(first, 'rpt', inProgress)]));
      if (!batchId) throw new Error('The commit saved no batch');
      // As an API from before #1255 saved it: no record of its macrocycles.
      const bundle = await repos();
      const saved = await bundle.importBatch.findById(batchId, user);
      if (!saved) throw new Error('The batch was not saved');
      await bundle.importBatch.save({ ...saved, macrocycles: null });

      const grown = run(RPT_DAYS, 0, 5);
      await commit(csvOf(grown), breakdownOf([stretch(grown, 'rpt', inProgress)]));
      await undo(batchId);
      expect(await macrocycles()).toEqual([expect.objectContaining({ startDate: at(6), endDate: at(8) })]);
    });
  });

  // #1257: the past-macrocycles list offers Undo for each of these.
  describe('the import list', () => {
    const listImports = async (program = 'rpt') => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${program}/import/batches`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      return res.json<ImportBatchSummary[]>();
    };
    /** The id of `program`'s macrocycle starting on day `n`. */
    const macrocycleOn = async (n: number, program = 'rpt') => {
      const row = (await macrocycles(program)).find((m) => ymd(m.startDate) === day(n));
      if (!row) throw new Error(`No ${program} macrocycle starts on day ${n}`);
      return row.id;
    };
    const createdAt = async (batchId: string | null) => {
      const batch = await (await repos()).importBatch.findById(batchId ?? '', user);
      if (!batch) throw new Error('The batch was not saved');
      return batch.createdAt.toISOString();
    };

    it("lists the lifter's imports newest first, each with its macrocycles and date", async () => {
      const first = run(RPT_DAYS, 0, 3);
      const second = run(RPT_DAYS, 30, 3);
      const fiveThreeOne = run(FIVE_THREE_ONE_DAYS, 60, 2);
      const third = run(RPT_DAYS, 80, 3);
      const a = await commit(csvOf(first), breakdownOf([stretch(first)]));
      const b = await commit(csvOf(second), breakdownOf([stretch(second)]));
      // An import through two programs is named by its Source program's batch in both lists.
      const c = await commit(csvOf([...fiveThreeOne, ...third]), breakdownOf([stretch(fiveThreeOne, '5-3-1'), stretch(third)]));

      expect(await listImports()).toEqual([
        { id: c.batchId, program: 'rpt', createdAt: await createdAt(c.batchId), macrocycleIds: [await macrocycleOn(80)] },
        { id: b.batchId, program: 'rpt', createdAt: await createdAt(b.batchId), macrocycleIds: [await macrocycleOn(30)] },
        { id: a.batchId, program: 'rpt', createdAt: await createdAt(a.batchId), macrocycleIds: [await macrocycleOn(0)] },
      ]);
      expect(await listImports('5-3-1')).toEqual([
        { id: c.batchId, program: 'rpt', createdAt: await createdAt(c.batchId), macrocycleIds: [await macrocycleOn(60, '5-3-1')] },
      ]);

      // An undone import is no longer listed.
      await undo(b.batchId);
      expect((await listImports()).map((i) => i.id)).toEqual([c.batchId, a.batchId]);
    });

    it("never lists another user's imports", async () => {
      const mine = run(RPT_DAYS, 0, 3);
      const { batchId } = await commit(csvOf(mine), breakdownOf([stretch(mine)]));
      const owner = user;

      user = `${owner}-other`;
      expect(await listImports()).toEqual([]);
      const theirs = run(RPT_DAYS, 40, 3);
      await commit(csvOf(theirs), breakdownOf([stretch(theirs)]));
      expect(await listImports()).toHaveLength(1);

      user = owner;
      expect((await listImports()).map((i) => i.id)).toEqual([batchId]);
    });
  });
});
