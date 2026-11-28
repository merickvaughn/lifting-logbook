// In-memory E2E for the `complexes` import (#1514): a complex the account can't take is reported in
// the preview and skipped, not failed, and undo removes what the import created. The round trip
// from one account to another runs against Postgres in data-export.db.e2e.spec.ts.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import type { InjectOptions } from 'fastify';
import type {
  BarbellComplexResponse,
  ImportCommitResponse,
  ImportPreviewResponse,
  ImportUndoResponse,
} from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const PROGRAM = '5-3-1';
const USER = 'complex-import-e2e';

// One complex per outcome: a name the account uses with other lifts, the same name with the same
// lifts (case differs), a lift's name, a lift the account lacks, and one that imports.
const FILE = [
  'Complex,Component,Lift,Reps',
  'BEAR,1,Deadlift,2',
  'BEAR,2,Squat,2',
  'Pull Flow,1,Romanian Deadlift,5',
  'Pull Flow,2,Front Squat,5',
  'squat,1,Deadlift,1',
  'squat,2,Front Squat,1',
  'Ghost,1,Deadlift,3',
  'Ghost,2,Muscle Snatchy,3',
  'Zercher Pair,2,Front Squat,4',
  'Zercher Pair,1,Zercher Hold,6',
  '',
].join('\n');

describe('complexes import (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;
  let zercherId: string;

  const auth = { authorization: `Bearer ${USER}` };
  const inject = (options: InjectOptions) => app.getHttpAdapter().getInstance().inject(options);
  const json = (method: 'POST' | 'GET', url: string, body?: unknown) =>
    inject({
      method,
      url,
      headers: { ...auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const upload = (mode: 'preview' | 'commit', csv: string, destination?: string) => {
    const boundary = '----ComplexImportBoundary';
    return inject({
      method: 'POST',
      url: `/programs/${PROGRAM}/import?mode=${mode}${destination ? `&destination=${destination}` : ''}`,
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="complexes.csv"',
        'Content-Type: text/csv',
        '',
        csv,
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
  };
  const complexes = async () => (await json('GET', '/lifts/complexes')).json<BarbellComplexResponse[]>();

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(multipart as any, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const lift = await json('POST', '/lifts/custom', { name: 'Zercher Hold', classification: 'accessory' });
    expect(lift.statusCode).toBe(201);
    zercherId = lift.json<{ id: string }>().id;
    for (const body of [
      { name: 'Bear', components: [{ lift: 'Deadlift', reps: 1 }, { lift: 'Front Squat', reps: 1 }] },
      { name: 'Pull flow', components: [{ lift: 'Romanian Deadlift', reps: 5 }, { lift: 'Front Squat', reps: 5 }] },
    ]) {
      expect((await json('POST', '/lifts/complexes', body)).statusCode).toBe(201);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('classifies the file and reports each complex it would skip, and why', async () => {
    const res = await upload('preview', FILE);

    expect(res.statusCode).toBe(200);
    const body = res.json<ImportPreviewResponse>();
    expect(body.classification.type).toBe('complexes');
    expect(body.errors).toEqual([]);
    const byLabel = Object.fromEntries((body.preview?.deltas ?? []).map((d) => [d.label, d]));
    expect(byLabel['BEAR']).toMatchObject({ kind: 'skip', message: expect.stringContaining('already have a complex named "Bear"') });
    // The same lifts under the same name: already imported, so skipped with nothing to say.
    expect(byLabel['Pull Flow']).toMatchObject({ kind: 'skip' });
    expect(byLabel['Pull Flow']?.message).toBeUndefined();
    expect(byLabel['squat']).toMatchObject({ kind: 'skip', message: expect.stringContaining("lift's name") });
    expect(byLabel['Ghost']).toMatchObject({ kind: 'skip', message: expect.stringContaining('"Muscle Snatchy"') });
    expect(byLabel['Zercher Pair']).toMatchObject({ kind: 'create', after: 'Zercher Hold × 6, Front Squat × 4' });
    expect(body.preview).toMatchObject({ creates: 1, skips: 4, unresolved: 0 });
  });

  it('fails a complex the file defines badly as a row error, not a skip', async () => {
    const res = await upload('preview', 'Complex,Component,Lift,Reps\nSolo,1,Deadlift,3\n', 'complexes');

    expect(res.statusCode).toBe(200);
    expect(res.json<ImportPreviewResponse>().errors).toEqual([
      expect.objectContaining({ row: 1, code: 'COMPLEX_NAME_INVALID' }),
    ]);
  });

  it('commits the one complex it can, with the custom lift by id, and undo removes it', async () => {
    const res = await upload('commit', FILE, 'complexes');

    expect(res.statusCode).toBe(200);
    const commit = res.json<ImportCommitResponse>();
    expect(commit).toMatchObject({ destination: 'complexes', created: 1, updated: 0, skipped: 4 });
    const zercher = (await complexes()).find((c) => c.name === 'Zercher Pair');
    expect(zercher?.components).toEqual([
      { lift: zercherId, reps: 6, name: 'Zercher Hold' },
      { lift: 'Front Squat', reps: 4, name: 'Front Squat' },
    ]);
    // The account's own complexes are as they were.
    expect((await complexes()).find((c) => c.name === 'Bear')?.components.map((c) => c.reps)).toEqual([1, 1]);

    const undo = await inject({ method: 'POST', url: `/programs/${PROGRAM}/import/${commit.batchId}/undo`, headers: auth });
    expect(undo.statusCode).toBe(200);
    expect(undo.json<ImportUndoResponse>()).toMatchObject({ restored: 1, skipped: 0 });
    expect((await complexes()).map((c) => c.name).sort()).toEqual(['Bear', 'Pull flow']);
  });

  // The commit, which needs a custom program and so Postgres, is in data-export.db.e2e.spec.ts.
  it("previews a program-spec row naming a complex by the account's complex, or says it has none", async () => {
    const spec = [
      'Week,Offset,Lift,Increment,Order,Sets,Reps,AMRAP?,Warm-Up %,WT Decrement %,Activation,Week Type',
      '1,0,complex:pull FLOW,5,1,3,1,FALSE,,0,,training',
      '1,0,complex:Nothing Here,5,2,3,1,FALSE,,0,,training',
      '',
    ].join('\n');
    const res = await upload('preview', spec, 'program-spec');

    expect(res.statusCode).toBe(200);
    const preview = res.json<ImportPreviewResponse>();
    expect(preview.errors).toEqual([]);
    const [found, missing] = preview.preview?.deltas ?? [];
    const pullFlow = (await complexes()).find((c) => c.name === 'Pull flow');
    // Keyed by the account's complex id, as the commit stores it, and labelled by its name.
    expect(found).toMatchObject({ key: `1:0:complex:${pullFlow?.id}:1`, label: 'Week 1 · Pull flow (#1)' });
    expect(found?.message).toBeUndefined();
    expect(missing).toMatchObject({ message: expect.stringContaining('no complex named "Nothing Here"') });
  });
});
