// In-memory E2E for the filtered sets download (#1308, proposal decision 22): its filters, its
// parts, and a round trip back through `/import`'s Assign step. Tenant isolation under row-level
// security is proven against Postgres in data-export.db.e2e.spec.ts.
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import type { InjectOptions } from 'fastify';
import { LIFT_RECORD_EXPORT_HEADERS, LiftRecord, parseCsvText } from '@lifting-logbook/core';
import type {
  ImportAssignResponse,
  ImportBreakdown,
  ImportCommitResponse,
  LiftRecordExportPartsResponse,
  MacrocycleStatus,
} from '@lifting-logbook/types';
import { InMemoryMacrocycleRepository } from '../adapters/in-memory/macrocycle.adapter';
import { AppModule } from '../app.module';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { MAX_IMPORT_ROWS } from '../programs/import-file.util';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const FLAG = 'IMPORT_ASSIGN_ENABLED';
const DAY_MS = 86_400_000;
const START = Math.floor(Date.now() / DAY_MS) * DAY_MS - 500 * DAY_MS;
const ymd = (date: Date) => date.toISOString().slice(0, 10);
const day = (n: number) => ymd(new Date(START + n * DAY_MS));
const PROGRAMS = ['rpt', '5-3-1', 'non-cycle'];

/** An exported CSV's rows as objects keyed by header. */
function rowsOf(csv: string): Record<string, string>[] {
  const [header = [], ...rows] = parseCsvText(csv).map((r) => r.map((c) => String(c ?? '')));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** What a round trip keeps: every exported column, in one order. */
const canonical = (csv: string) =>
  rowsOf(csv)
    .map((r) => LIFT_RECORD_EXPORT_HEADERS.map((h) => r[h]).join('|'))
    .sort();

describe('Filtered sets download (#1308, e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;
  const savedFlag = process.env[FLAG];

  beforeAll(async () => {
    process.env[FLAG] = 'true';
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

  let user = 'lift-record-export-e2e-0';
  let nextUser = 0;
  beforeEach(() => {
    user = `lift-record-export-e2e-${++nextUser}`;
  });

  const auth = (as = user) => ({ authorization: `Bearer ${as}` });
  const inject = (options: InjectOptions) => app.getHttpAdapter().getInstance().inject(options);
  const repos = (as = user): Promise<RepositoryBundle> =>
    app.get<IRepositoryFactory>(REPOSITORY_FACTORY).forUser({ id: as, email: `${as}@example.com`, provider: 'dev' });

  const query = (filter: Record<string, string | number | undefined>) => {
    const params = Object.entries(filter).filter((e): e is [string, string | number] => e[1] !== undefined);
    return params.length === 0 ? '' : `?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  };
  const download = (filter: Record<string, string | number | undefined> = {}, as = user) =>
    inject({ method: 'GET', url: `/users/me/export/lift-records${query(filter)}`, headers: auth(as) });
  const csvOf = async (filter: Record<string, string | number | undefined> = {}, as = user) => {
    const res = await download(filter, as);
    expect(res.statusCode).toBe(200);
    return res.body;
  };
  const partsOf = async (filter: Record<string, string | undefined> = {}, as = user) => {
    const res = await inject({ method: 'GET', url: `/users/me/export/lift-records/parts${query(filter)}`, headers: auth(as) });
    expect(res.statusCode).toBe(200);
    return res.json<LiftRecordExportPartsResponse>();
  };

  const upload = (csv: string, mode: string, fields: Record<string, string> = {}) => {
    const boundary = '----LiftRecordExportBoundary';
    const parts = [
      ...Object.entries(fields).flatMap(([name, value]) => [`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', value]),
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="upload.csv"',
      'Content-Type: text/csv',
      '',
      csv,
      `--${boundary}--`,
    ];
    return inject({
      method: 'POST',
      url: `/programs/rpt/import?mode=${mode}&destination=lift-records`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...auth() },
      payload: parts.join('\r\n'),
    });
  };

  /**
   * Imports an exported file as the wizard does: `mode=assign`, then a commit of its stretches as
   * Assign grouped them, each with the file's status.
   */
  const reimport = async (csv: string) => {
    const assigned = await upload(csv, 'assign');
    expect(assigned.statusCode).toBe(200);
    const body = assigned.json<ImportAssignResponse>();
    expect(body.exported).toBe(true);
    const breakdown: ImportBreakdown = {
      stretches: body.stretches.map((s) => ({
        program: s.program,
        file: { group: s.fileGroup ?? '', macrocycleNum: s.fileMacrocycleNum ?? 0 },
        status: s.fileStatus ?? s.status ?? 'unknown',
        statusChosen: s.fileStatus !== null,
      })),
      excludedDates: [],
      nonCycleDates: [],
    };
    const committed = await upload(csv, 'commit', { breakdown: JSON.stringify(breakdown) });
    expect(committed.statusCode).toBe(200);
    return committed.json<ImportCommitResponse>();
  };

  /** Removes every set and macrocycle, as clearing the account's training data does. */
  const clearSets = async () => {
    const bundle = await repos();
    for (const program of PROGRAMS) await bundle.macrocycle.deleteAllExcept(program, []);
  };

  const statuses = async () =>
    (await (await repos()).macrocycle.listAll()).map(
      (m) => `${m.program}:${m.macrocycleNum}:${m.status}:${m.statusChosen ? 'chosen' : 'inferred'}:${m.origin}`,
    );

  /**
   * Stores sets and their macrocycle directly, as a lifter's history would be. Its status is one
   * the lifter chose unless `statusChosen` says the rules inferred it.
   */
  const seed = async (
    program: string,
    macrocycleNum: number,
    status: MacrocycleStatus,
    sets: Array<Partial<LiftRecord> & { day: number }>,
    as = user,
    statusChosen = true,
  ) => {
    const bundle = await repos(as);
    const days = sets.map((s) => s.day);
    const macrocycle = (bundle.macrocycle as InMemoryMacrocycleRepository).seed({
      program,
      macrocycleNum,
      startDate: new Date(START + Math.min(...days) * DAY_MS),
      endDate: new Date(START + Math.max(...days) * DAY_MS),
      status,
      statusChosen,
      origin: 'imported',
      unmatched: false,
      importedThrough: null,
    });
    await bundle.liftRecord.appendLiftRecords(
      program,
      sets.map(({ day: d, ...s }) => ({
        program,
        macrocycleNum,
        workoutNum: 1,
        date: new Date(START + d * DAY_MS),
        lift: 'Bench Press',
        setNum: 1,
        weight: 100,
        reps: 5,
        notes: '',
        ...s,
      })) as LiftRecord[],
    );
    return macrocycle;
  };

  describe('filters', () => {
    let OTHER = '';
    let rptTwo = '';

    beforeEach(async () => {
      OTHER = `${user}-other`;
      await seed('rpt', 1, 'completed', [{ day: 0 }, { day: 2, workoutNum: 2 }]);
      rptTwo = (await seed('rpt', 2, 'abandoned', [{ day: 10 }, { day: 12, workoutNum: 2 }])).id;
      await seed('5-3-1', 1, 'overran', [{ day: 4, lift: 'Squat' }], user, false);
      await seed('rpt', 1, 'completed', [{ day: 0, notes: 'other lifter' }, { day: 10, notes: 'other lifter' }], OTHER);
    });

    const dates = (csv: string) => rowsOf(csv).map((r) => `${r.Program}:${r['Macrocycle #']}:${r.Date}`).sort();

    it('takes every program with no filter, and each set carries its status where the lifter chose it', async () => {
      const rows = rowsOf(await csvOf());
      // 5-3-1's `overran` was inferred, so it's left for the rules to suggest again on re-upload.
      expect(rows.map((r) => `${r.Program}:${r['Macrocycle #']}:${r.Status}`).sort()).toEqual([
        '5-3-1:1:',
        'rpt:1:completed',
        'rpt:1:completed',
        'rpt:2:abandoned',
        'rpt:2:abandoned',
      ]);
    });

    it('filters by program', async () => {
      expect(dates(await csvOf({ program: '5-3-1' }))).toEqual([`5-3-1:1:${day(4)}`]);
    });

    it('filters by macrocycle, by its stable id', async () => {
      expect(dates(await csvOf({ macrocycle: rptTwo }))).toEqual([`rpt:2:${day(10)}`, `rpt:2:${day(12)}`]);
      expect(dates(await csvOf({ macrocycle: rptTwo, program: 'rpt' }))).toHaveLength(2);
    });

    it('filters by date range, both ends included', async () => {
      expect(dates(await csvOf({ from: day(2), to: day(10) }))).toEqual([
        `5-3-1:1:${day(4)}`,
        `rpt:1:${day(2)}`,
        `rpt:2:${day(10)}`,
      ]);
      expect(dates(await csvOf({ program: 'rpt', from: day(11) }))).toEqual([`rpt:2:${day(12)}`]);
      expect(dates(await csvOf({ to: day(0) }))).toEqual([`rpt:1:${day(0)}`]);
    });

    it("never returns another user's sets, and gives a header alone when nothing matches", async () => {
      for (const filter of [{}, { program: 'rpt' }, { from: day(0), to: day(20) }]) {
        expect(await csvOf(filter)).not.toContain('other lifter');
      }
      expect(rowsOf(await csvOf({}, OTHER))).toHaveLength(2);
      expect(rowsOf(await csvOf({ program: 'leangains' }))).toEqual([]);
      expect(parseCsvText(await csvOf({ program: 'leangains' }))[0]).toEqual(LIFT_RECORD_EXPORT_HEADERS);
    });

    it("404s another user's macrocycle id, and rejects a bad filter", async () => {
      expect((await download({ macrocycle: rptTwo }, OTHER)).statusCode).toBe(404);
      expect((await download({ macrocycle: rptTwo, program: '5-3-1' })).statusCode).toBe(400);
      expect((await download({ from: '2026-02-30' })).statusCode).toBe(400);
      expect((await download({ from: 'yesterday' })).statusCode).toBe(400);
      expect((await download({ from: day(5), to: day(4) })).statusCode).toBe(400);
      expect((await download({ part: 0 })).statusCode).toBe(400);
      expect((await download({ part: 2 })).statusCode).toBe(404);
      expect((await download({ colour: 'red' })).statusCode).toBe(400);
    });

    it('lists one part with its counts and dates, and names the file', async () => {
      expect(await partsOf({ program: 'rpt' })).toEqual({
        rows: 4,
        parts: [{ part: 1, rows: 4, from: day(0), to: day(12) }],
        split: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(await partsOf({ program: 'leangains' })).toMatchObject({ rows: 0, parts: [] });
      const res = await download();
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="lift-records-\d{4}-\d{2}-\d{2}\.csv"$/);
    });

    it('refuses a part once a set added or removed may have moved the split, and not before', async () => {
      const { split } = await partsOf();
      expect((await download({ part: 1, split })).statusCode).toBe(200);
      // A different filter is a different split.
      expect((await download({ part: 1, split, program: 'rpt' })).statusCode).toBe(409);
      await (await repos()).liftRecord.appendLiftRecords('rpt', [
        {
          program: 'rpt',
          macrocycleNum: 2,
          workoutNum: 3,
          date: new Date(START + 14 * DAY_MS),
          lift: 'Bench Press',
          setNum: 1,
          weight: 100,
          reps: 5,
          notes: '',
        },
      ] as LiftRecord[]);
      const changed = await download({ part: 1, split });
      expect(changed.statusCode).toBe(409);
      expect(changed.json<{ message: string }>().message).toMatch(/List the parts again/);
      expect((await download({ part: 1, split: (await partsOf()).split })).statusCode).toBe(200);
      expect((await download({ split: 'not-a-split' })).statusCode).toBe(400);
    });

    it('refuses a request with no token', async () => {
      expect((await inject({ method: 'GET', url: '/users/me/export/lift-records' })).statusCode).toBe(401);
      expect((await inject({ method: 'GET', url: '/users/me/export/lift-records/parts' })).statusCode).toBe(401);
    });

    it('logs which filters were set and the counts, never their values', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        await csvOf({ program: 'rpt', from: day(0) });
        const logged = JSON.stringify(log.mock.calls);
        expect(logged).toContain('Sets export downloaded (#1308)');
        expect(logged).toContain('"rows":4');
        expect(logged).not.toContain('rpt');
        expect(logged).not.toContain(day(0));
      } finally {
        log.mockRestore();
      }
    });
  });

  describe('round trip through the Assign step', () => {
    /**
     * The fixture the criterion lists, as an exported file: two identical same-day workouts, a
     * note mentioning "1rm", a set with a modification, the same number in two programs, two
     * overlapping macrocycles in one program, and a non-cycle workout.
     */
    const fixture = (modificationId: string) => {
      const line = (cells: Array<string | number>) => cells.join(',');
      const set = (program: string, m: number, w: number, d: number, lift: string, extra: { occ?: number; notes?: string; mods?: string; status?: string } = {}) =>
        // The last two cells are Complex and Round (#1494), empty: none of these sets is in a complex.
        line([program, m, w, day(d), lift, 1, 100, 5, extra.notes ?? '', extra.occ ?? 0, extra.mods ?? '', extra.status ?? '', '', '']);
      const rptOne = (w: number, d: number, extra: { occ?: number; notes?: string; mods?: string } = {}) =>
        ['Bench Press', 'Barbell Row', 'Overhead Press'].map((lift, i) =>
          set('rpt', 1, w, d, lift, {
            status: 'completed',
            ...extra,
            notes: i === 0 ? (extra.notes ?? '') : '',
            // The modification is the bench press's, so only that set carries it.
            mods: i === 0 ? (extra.mods ?? '') : '',
          }),
        );
      return [
        LIFT_RECORD_EXPORT_HEADERS.join(','),
        // Two identical workouts on day 0, told apart by occurrence.
        ...rptOne(1, 0),
        ...rptOne(2, 0, { occ: 1 }),
        ...rptOne(3, 2, { notes: 'new 1rm attempt next week' }),
        ...rptOne(4, 4, { mods: modificationId }),
        // Overlaps rpt 1's dates.
        set('rpt', 2, 1, 1, 'Squat', { status: 'abandoned' }),
        set('rpt', 2, 2, 3, 'Deadlift', { status: 'abandoned' }),
        // The same number in another program.
        set('5-3-1', 1, 1, 6, 'Squat', { status: 'overran' }),
        set('5-3-1', 1, 2, 8, 'Bench Press', { status: 'overran' }),
        set('non-cycle', 1, 1, 7, 'Bench Press'),
      ].join('\n');
    };

    const modification = async () =>
      (await repos()).liftModification.create({ lift: 'bench-press', name: 'Paused', description: '', maxMode: 'none' });

    it('keeps every set, grouping and status, adds nothing on a second import, and changes no max', async () => {
      const { id } = await modification();
      const first = await reimport(fixture(id));
      expect(first.created).toBe(17);
      expect(first.assigned?.droppedModifications).toBe(0);

      const exported = await csvOf();
      expect(rowsOf(exported)).toHaveLength(17);
      const before = { sets: canonical(exported), macrocycles: await statuses() };
      // What the fixture asked for is what's stored.
      expect(before.macrocycles.sort()).toEqual([
        '5-3-1:1:overran:chosen:imported',
        'non-cycle:1:unknown:inferred:non-cycle',
        'rpt:1:completed:chosen:imported',
        'rpt:2:abandoned:chosen:imported',
      ]);
      // Import stores a catalog lift by its id, which the export then writes.
      expect(rowsOf(exported).filter((r) => r.Date === day(0) && r.Lift === 'bench-press').map((r) => r.Occurrence).sort()).toEqual(['0', '1']);
      expect(rowsOf(exported).filter((r) => r.Modifications !== '').map((r) => r.Modifications)).toEqual([id]);

      // Re-importing without a clear adds nothing.
      expect((await reimport(exported)).created).toBe(0);

      await clearSets();
      expect(rowsOf(await csvOf())).toEqual([]);
      expect((await reimport(exported)).created).toBe(17);

      expect(canonical(await csvOf())).toEqual(before.sets);
      expect((await statuses()).sort()).toEqual(before.macrocycles.sort());
      // The "1rm" note stayed a set, so no max was written.
      expect(await (await repos()).trainingMax.getTrainingMaxes('rpt')).toEqual([]);
    });

    it('drops and counts a modification id the account no longer has', async () => {
      const { id } = await modification();
      // The fixture's one modified set names a known id and an unknown one.
      const csv = fixture(`${id};00000000-0000-4000-8000-000000000000`);
      const result = await reimport(csv);
      expect(result.assigned?.droppedModifications).toBe(1);
      const modified = rowsOf(await csvOf()).filter((r) => r.Modifications !== '');
      expect(modified.map((r) => r.Modifications)).toEqual([id]);
      // The count is of the file's rows, so a re-import that adds nothing still says what it named.
      const again = await reimport(csv);
      expect(again.created).toBe(0);
      expect(again.assigned?.droppedModifications).toBe(1);
    });

    it("drops another lift's modification, a repeat, and a second with its own max, as logging a set would", async () => {
      const bundle = await repos();
      const create = (lift: string, name: string, maxMode: 'own' | 'none') =>
        bundle.liftModification.create({ lift, name, description: '', maxMode });
      const paused = await create('bench-press', 'Paused', 'own');
      const spoto = await create('bench-press', 'Spoto', 'own');
      const tempo = await create('bench-press', 'Tempo', 'none');
      const box = await create('squat', 'Box', 'none');
      const result = await reimport(fixture([paused.id, paused.id, spoto.id, box.id, tempo.id].join(';')));
      expect(result.assigned?.droppedModifications).toBe(3);
      const modified = rowsOf(await csvOf()).filter((r) => r.Modifications !== '');
      expect(modified.map((r) => r.Modifications)).toEqual([`${paused.id};${tempo.id}`]);
    });

    it('checks the ids on a commit sent without a breakdown too', async () => {
      const { id } = await modification();
      const row = ['rpt', 1, 1, day(0), 'Bench Press', 1, 100, 5, '', 0, `${id};00000000-0000-4000-8000-000000000000`, '', '', ''];
      const csv = [LIFT_RECORD_EXPORT_HEADERS.join(','), row.join(',')].join('\n');
      expect((await upload(csv, 'commit')).statusCode).toBe(200);
      const stored = await (await repos()).liftRecord.getLiftRecords('rpt', 1);
      expect(stored.map((r) => r.modifications)).toEqual([[id]]);
    });

    it.each(['=', '+', '-', '@', '\t', '\r', '\n'])('exports a note starting with %j escaped, and reads it back as written', async (trigger) => {
      const note = `${trigger}1+1`;
      // A note that really starts with an apostrophe before the trigger gets one more, so it too
      // comes back as written.
      await seed('rpt', 1, 'completed', [
        { day: 0, notes: note },
        { day: 0, setNum: 2, notes: "'tis paused", weight: -10 },
        { day: 0, setNum: 3, notes: `'${note}` },
      ]);
      const exported = await csvOf();
      const raw = rowsOf(exported);
      expect(raw.map((r) => r.Notes).sort()).toEqual([`'${note}`, "'tis paused", `''${note}`].sort());
      expect(raw.find((r) => r['Set #'] === '2')?.Weight).toBe('-10');

      await clearSets();
      expect((await reimport(exported)).created).toBe(3);
      const stored = await (await repos()).liftRecord.getLiftRecords('rpt', 1);
      expect(stored.map((r) => r.notes).sort()).toEqual([note, "'tis paused", `'${note}`].sort());
      expect(stored.find((r) => r.setNum === 2)?.weight).toBe(-10);
    });
  });

  describe('a long history', () => {
    // Catalog ids, as an import stores them, so the history compares equal after its round trip.
    const RPT_LIFTS = ['bench-press', 'barbell-row', 'overhead-press'];
    /** Every part of the unfiltered download, as one canonical list. */
    const allParts = async () => {
      const { parts } = await partsOf();
      const sets: string[] = [];
      for (const { part } of parts) sets.push(...canonical(await csvOf({ part })));
      return sets.sort();
    };
    // 70 sessions of 3 lifts x 10 sets is 2,100 sets per macrocycle, so three don't fit one part.
    const sessions = (first: number): Array<Partial<LiftRecord> & { day: number }> =>
      Array.from({ length: 70 }, (_, s) =>
        RPT_LIFTS.flatMap((lift) =>
          Array.from({ length: 10 }, (_, set) => ({ day: first + s * 2, workoutNum: s + 1, lift, setNum: set + 1 })),
        ),
      ).flat();

    it('comes in parts under the limit, cut between macrocycles, which restore everything uploaded oldest first', async () => {
      await seed('rpt', 1, 'completed', sessions(0));
      await seed('rpt', 2, 'abandoned', sessions(140));
      await seed('rpt', 3, 'overran', sessions(280));
      const before = { sets: await allParts(), macrocycles: await statuses() };
      expect(before.sets.length).toBeGreaterThan(MAX_IMPORT_ROWS);

      const { rows, parts } = await partsOf();
      expect(rows).toBe(6300);
      expect(parts.map((p) => p.rows)).toEqual([4200, 2100]);
      expect(parts.map((p) => [p.from, p.to])).toEqual([
        [day(0), day(278)],
        [day(280), day(418)],
      ]);

      const files = [];
      for (const { part } of parts) {
        const res = await download({ part });
        expect(res.headers['content-disposition']).toContain(`-part-${part}-of-2.csv`);
        const fileRows = rowsOf(res.body);
        expect(fileRows.length).toBeLessThanOrEqual(MAX_IMPORT_ROWS);
        files.push(res.body);
      }
      // No macrocycle is split across parts.
      const numbersIn = (csv: string) => new Set(rowsOf(csv).map((r) => r['Macrocycle #']));
      expect([...numbersIn(files[0] ?? '')].sort()).toEqual(['1', '2']);
      expect([...numbersIn(files[1] ?? '')]).toEqual(['3']);

      await clearSets();
      for (const file of files) await reimport(file);
      expect(await allParts()).toEqual(before.sets);
      expect((await statuses()).sort()).toEqual(before.macrocycles.sort());
    }, 120_000);
  });
});
