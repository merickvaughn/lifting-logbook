// In-memory E2E for Download My Data (#947): auth, the archive, the empty account, what's logged,
// and CSV files going back through /import. Table coverage and tenant isolation are proven against
// Postgres in data-export.db.e2e.spec.ts.
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import type { InjectOptions } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import type { ImportCommitResponse, ImportPreviewResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const PROGRAM = 'data-export-e2e';
const SECRET_NOTE = 'private-note-from-the-lifter';
const LIFT_RECORD_HEADER = 'Program,Macrocycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes';

describe('Download My Data HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  const auth = (user: string) => ({ authorization: `Bearer ${user}` });
  const inject = (options: InjectOptions) => app.getHttpAdapter().getInstance().inject(options);
  const exportFor = (user: string) =>
    inject({ method: 'GET', url: '/users/me/export', headers: auth(user) });

  const unzip = (body: Buffer): Record<string, string> =>
    Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(body))).map(([path, bytes]) => [path, strFromU8(bytes)]),
    );

  const upload = (user: string, mode: 'preview' | 'commit', csv: string, destination?: string) => {
    const boundary = '----DataExportBoundary';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="upload.csv"',
      'Content-Type: text/csv',
      '',
      csv,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const target = destination ? `&destination=${destination}` : '';
    return inject({
      method: 'POST',
      url: `/programs/${PROGRAM}/import?mode=${mode}${target}`,
      headers: { ...auth(user), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  };

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(multipart as any, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a request with no token', async () => {
    const res = await inject({ method: 'GET', url: '/users/me/export' });
    expect(res.statusCode).toBe(401);
  });

  it('sends a dated zip attachment', async () => {
    const res = await exportFor('export-empty');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lifting-logbook-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
  });

  it('gives an empty account a valid archive', async () => {
    const files = unzip((await exportFor('export-empty')).rawPayload);

    expect(Object.keys(files).sort()).toEqual([
      'lift-records.csv',
      'logbook.json',
      'program-spec.csv',
      'strength-goals.csv',
      'training-maxes.csv',
    ]);
    const logbook = JSON.parse(files['logbook.json']!);
    expect(logbook.schemaVersion).toBe(1);
    expect(Number.isNaN(Date.parse(logbook.exportedAt))).toBe(false);
    expect(logbook.tables.liftRecords).toEqual([]);
    expect(logbook.tables.focusBlocks).toEqual([]);
  });

  it('logs row counts, never row contents', async () => {
    const user = 'export-logging';
    const seeded = await upload(
      user,
      'commit',
      `${LIFT_RECORD_HEADER}\n${PROGRAM},1,1,2026-01-05,Squat,1,200,5,${SECRET_NOTE}\n`,
      'lift-records',
    );
    expect(seeded.statusCode).toBeLessThan(300);

    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const res = await exportFor(user);
    const logged = JSON.stringify(log.mock.calls);
    log.mockRestore();

    expect(unzip(res.rawPayload)['lift-records.csv']).toContain(SECRET_NOTE);
    expect(logged).toContain('Data export started');
    expect(logged).toContain('Data export finished');
    expect(logged).toMatch(/"liftRecords":1/);
    expect(logged).not.toContain(SECRET_NOTE);
    expect(logged).not.toContain('Squat');
  });

  it('writes a custom lift by name, and leaves the user id out of logbook.json', async () => {
    const user = 'export-custom-lift';
    const created = await inject({
      method: 'POST',
      url: '/lifts/custom',
      headers: { ...auth(user), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Zercher Squat', classification: 'compound' }),
    });
    expect(created.statusCode).toBeLessThan(300);
    const { id } = created.json() as { id: string };

    const files = unzip((await exportFor(user)).rawPayload);
    const logbook = JSON.parse(files['logbook.json']!);

    expect(logbook.tables.customLifts).toEqual([expect.objectContaining({ id, name: 'Zercher Squat' })]);
    expect(files['logbook.json']).not.toContain('"userId"');
  });

  it.each([
    ['lift-records.csv', 'lift-records'],
    ['training-maxes.csv', 'training-maxes'],
    ['strength-goals.csv', 'strength-goals'],
  ])('sends %s back through /import, classified and with no errors', async (file, kind) => {
    const source = `export-source-${kind}`;
    const target = `export-target-${kind}`;
    const seed: Record<string, string> = {
      // `Calf Raises` is a built-in preset's own name for a catalog lift, stored as written.
      'lift-records': `${LIFT_RECORD_HEADER}\n${PROGRAM},1,1,2026-01-05,Squat,1,200,5,\n${PROGRAM},1,1,2026-01-05,Calf Raises,1,150,5,\n`,
      'training-maxes': 'Date Updated,Lift,Weight\n2026-01-05,Squat,300\n2026-01-05,Bench Press,200\n',
      'strength-goals':
        "Today's Date,2026-01-05,,,\nLift,Current TM,Intermediate,Advanced,Elite\nSquat,,400,,\nBench Press,,300,,\nGoal Date,N/A,,,\n",
    };
    const seeded = await upload(source, 'commit', seed[kind]!, kind);
    expect(seeded.statusCode).toBeLessThan(300);
    const switched = await inject({
      method: 'PATCH',
      url: '/users/me/settings',
      headers: { ...auth(source), 'content-type': 'application/json' },
      payload: JSON.stringify({ activeProgram: PROGRAM }),
    });
    expect(switched.statusCode).toBeLessThan(300);

    const csv = unzip((await exportFor(source)).rawPayload)[file]!;
    const res = await upload(target, 'preview', csv);

    expect(res.statusCode).toBeLessThan(300);
    const preview = res.json() as ImportPreviewResponse;
    expect(preview.classification.type).toBe(kind);
    expect(preview.destination).toBe(kind);
    expect(preview.errors).toEqual([]);
    // `errors` can't catch a lift it doesn't recognize: that row is only marked for a decision.
    expect(preview.preview?.unresolved).toBe(0);

    const committed = await upload(target, 'commit', csv, kind);
    expect(committed.statusCode).toBeLessThan(300);
    expect((committed.json() as ImportCommitResponse).created).toBeGreaterThan(0);
  });
});
