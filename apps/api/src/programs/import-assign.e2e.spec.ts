import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import type { ImportAssignResponse, ImportPreviewResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainNotFoundFilter } from './not-found.filter';

/**
 * In-memory E2E for the Assign step's read side (#1253): the `IMPORT_ASSIGN_ENABLED` flag on
 * `mode=preview`, and `mode=assign`'s grouping of a lift-records file into suggested macrocycles.
 */
describe('Import Assign step (#1253, e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;
  const FLAG = 'IMPORT_ASSIGN_ENABLED';
  const savedFlag = process.env[FLAG];

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    await app.register(multipart as never, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  let AUTH = { authorization: 'Bearer import-assign-e2e-0' };
  let nextUser = 0;
  beforeEach(() => {
    AUTH = { authorization: `Bearer import-assign-e2e-${++nextUser}` };
    process.env[FLAG] = 'true';
  });

  const importCsv = (program: string, csv: string, query = '', fields: Record<string, string> = {}) => {
    const boundary = '----AssignBoundary';
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
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...AUTH },
      payload: parts.join('\r\n'),
    });
  };

  // The server takes an import date within a day of its own, so the history is dated back from today.
  const DAY_MS = 86_400_000;
  const TODAY = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS);
  const START = TODAY.getTime() - 120 * DAY_MS;
  const ymd = (date: Date) => date.toISOString().slice(0, 10);
  const day = (n: number) => ymd(new Date(START + n * DAY_MS));
  const today = ymd(TODAY);

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
    const withNumbers = rows.some((r) => r.macrocycle !== undefined);
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

  const assign = async (program: string, csv: string, query = '', fields: Record<string, string> = {}) => {
    const res = await importCsv(program, csv, `?mode=assign&destination=lift-records${query}`, { today, ...fields });
    expect(res.statusCode).toBe(200);
    return res.json<ImportAssignResponse>();
  };

  const preview = async (csv: string) => {
    // A file with none of the number columns may not classify on its own, so the wizard names the kind.
    const res = await importCsv('rpt', csv, '?destination=lift-records');
    expect(res.statusCode).toBe(200);
    return res.json<ImportPreviewResponse>();
  };

  /** Required fields the file has no column for. */
  const missingRequired = (body: ImportPreviewResponse) =>
    (body.columnMappings ?? []).filter((m) => m.required && m.sourceHeader === '').map((m) => m.destinationField);

  describe('with the flag unset', () => {
    beforeEach(() => {
      delete process.env[FLAG];
    });

    it('previews as before: the number columns are required and mode=assign does not exist', async () => {
      const csv = csvOf(run(RPT_DAYS, 0, 3));
      const body = await preview(csv);
      expect(body.assignEnabled).toBe(false);
      expect(missingRequired(body).sort()).toEqual(['macrocycleNum', 'program', 'workoutNum']);
      expect(body.preview?.deltas.every((d) => d.status === 'incomplete')).toBe(true);

      const res = await importCsv('rpt', csv, '?mode=assign&destination=lift-records', { today });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('with the flag on', () => {
    it('previews a file with no program, macrocycle or workout columns with nothing missing', async () => {
      const body = await preview(csvOf(run(RPT_DAYS, 0, 3)));
      expect(body.assignEnabled).toBe(true);
      expect(missingRequired(body)).toEqual([]);
      expect(body.preview?.unresolved).toBe(0);
      expect(body.preview?.creates).toBe(9);
    });

    it('groups such a file into stretches from its dates', async () => {
      // 12 RPT sessions, a 20-day break, then 3 more ending two days before today.
      const lastDay = 118;
      const rows = [...run(RPT_DAYS, 0, 12), ...run(RPT_DAYS, lastDay - 4, 3)];
      const body = await assign('rpt', csvOf(rows));

      expect(body.importDate).toBe(today);
      expect(body.sessions).toBe(15);
      expect(body.stretches.map((s) => [s.program, s.startDate, s.endDate, s.sessions.length, s.status])).toEqual([
        ['rpt', day(0), day(22), 12, 'abandoned'],
        ['rpt', day(lastDay - 4), day(lastDay), 3, 'in-progress'],
      ]);
      const every2 = (from: number, count: number) => Array.from({ length: count }, (_, i) => day(from + i * 2));
      expect(body.stretches.map((s) => s.sessions.map((x) => x.date))).toEqual([
        every2(0, 12),
        every2(lastDay - 4, 3),
      ]);
      const [first, second] = body.stretches;
      expect(first?.matched).toBe(true);
      expect(first?.expectedWorkouts).toBe(24);
      expect(first?.reasons.status).toEqual({ kind: 'next-is-restart' });
      expect(second?.reasons.start).toEqual({ kind: 'gap', days: lastDay - 4 - 22 });
      expect(first?.sessions[0]).toEqual({
        date: day(0),
        workoutNum: 1,
        lifts: ['Bench Press', 'Barbell Row', 'Overhead Press'],
        sets: 3,
      });
      expect(body.programs.map((p) => p.id)).toEqual(expect.arrayContaining(['rpt', '5-3-1', 'leangains']));
    });

    it("applies Review's exclusions and lift overrides", async () => {
      const rows = [{ day: 0, lift: 'Bench Press' }, ...run(RPT_DAYS, 2, 3)];
      // Row 1 is the only row on day 0; row 2 is day 2's Bench Press.
      const body = await assign('rpt', csvOf(rows), '', {
        excludeKeys: JSON.stringify(['__row_1']),
        liftOverrides: JSON.stringify({ 2: 'Dips' }),
      });
      const sessions = body.stretches.flatMap((s) => s.sessions);
      expect(sessions.map((s) => s.date)).not.toContain(day(0));
      expect(sessions[0]?.lifts).toEqual(['Dip', 'Barbell Row', 'Overhead Press']);
    });

    it('flags file numbers that conflict with the dates, and an export', async () => {
      const gapInside = [
        ...run(RPT_DAYS, 0, 3, { program: 'rpt', macrocycle: 1 }),
        ...run(RPT_DAYS, 30, 3, { program: 'rpt', macrocycle: 1 }),
      ];
      const gap = await assign('rpt', csvOf(gapInside));
      expect(gap.conflicts).toEqual([{ kind: 'gap-inside-number', stretch: 0, from: day(4), to: day(30), days: 26 }]);
      expect(gap.exported).toBe(false);

      // Macrocycles 2 and 3 of one program interleave their dates.
      const overlapping = [
        ...run(RPT_DAYS, 0, 3, { program: 'rpt', macrocycle: 2 }),
        ...run(RPT_DAYS, 1, 3, { program: 'rpt', macrocycle: 3 }),
      ];
      const overlap = await assign('rpt', csvOf(overlapping));
      expect(overlap.conflicts).toEqual([{ kind: 'numbers-overlap', stretches: [0, 1] }]);

      const exported = await assign('rpt', csvOf(overlapping, ['Occurrence']));
      expect(exported.exported).toBe(true);
    });

    it('counts rows with no date, and groups the rest', async () => {
      const rows = [...run(RPT_DAYS, 0, 3), { day: null, lift: 'Squat' }, { day: null, lift: 'Dips' }];
      const previewed = await preview(csvOf(rows));
      expect(previewed.preview?.unresolved).toBe(0);
      expect(previewed.preview?.deltas.filter((d) => d.status === 'undated')).toHaveLength(2);

      const body = await assign('rpt', csvOf(rows));
      expect(body.undatedRows).toBe(2);
      expect(body.stretches).toHaveLength(1);
      expect(body.stretches[0]?.sessions).toHaveLength(3);
    });

    it('returns a lone session inside a break as a flag', async () => {
      const rows = [...run(RPT_DAYS, 0, 3), { day: 19, lift: 'Bench Press' }, ...run(RPT_DAYS, 34, 3)];
      const body = await assign('rpt', csvOf(rows));
      expect(body.lone).toEqual([
        {
          session: { date: day(19), workoutNum: null, lifts: ['Bench Press'], sets: 1 },
          daysAfterPrevious: 15,
          daysBeforeNext: 15,
        },
      ]);
      expect(body.stretches).toHaveLength(2);
    });

    it('counts split rows against the max of the program covering their date', async () => {
      // rpt's Squat max is dated after its stretch's one-rep-max row; 5-3-1 has no maxes.
      const tm = await importCsv(
        'rpt',
        ['Date Updated,Lift,Weight', `${day(100)},Squat,300`].join('\n'),
        '?mode=commit&destination=training-maxes',
      );
      expect(tm.statusCode).toBe(200);

      const rows = [
        ...run(FIVE_THREE_ONE_DAYS, 0, 6, { program: '5-3-1' }),
        { day: 5, lift: 'Squat', program: '5-3-1', notes: '1RM test', weight: 315 },
        ...run(RPT_DAYS, 14, 6, { program: 'rpt' }),
        { day: 19, lift: 'Squat', program: 'rpt', notes: '1RM test', weight: 320 },
      ];
      const body = await assign('rpt', csvOf(rows), '&splitDest=1');
      expect(body.stretches.map((s) => s.program)).toEqual(['5-3-1', 'rpt']);
      expect(body.split).toEqual({ changes: 1, olderThanCurrent: 1 });
      // Split rows aren't sessions.
      expect(body.sessions).toBe(12);

      const unsplit = await assign('rpt', csvOf(rows));
      expect(unsplit.split).toBeUndefined();
      expect(unsplit.sessions).toBe(14);
    });

    it('logs counts and no lift names', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      try {
        await assign('rpt', csvOf([...run(RPT_DAYS, 0, 3), { day: 19, lift: 'Bench Press' }, ...run(RPT_DAYS, 34, 3)]));
        const call = log.mock.calls.find(([, message]) => message === 'Import assign (#1253)');
        expect(call?.[0]).toEqual(
          expect.objectContaining({ sessions: 7, stretches: 2, loneSessions: 1, conflicts: 0, undatedRows: 0 }),
        );
        expect(JSON.stringify(call?.[0])).not.toMatch(/Bench|Squat|Press/);
      } finally {
        log.mockRestore();
      }
    });

    it('refuses an import date more than a day from the server’s', async () => {
      const res = await importCsv('rpt', csvOf(run(RPT_DAYS, 0, 3)), '?mode=assign&destination=lift-records', {
        today: day(0),
      });
      expect(res.statusCode).toBe(400);
    });

    it('takes only lift records', async () => {
      const res = await importCsv('rpt', 'Date Updated,Lift,Weight\n2026-01-01,Squat,300', '?mode=assign&destination=training-maxes', { today });
      expect(res.statusCode).toBe(400);
    });
  });
});
