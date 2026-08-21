import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainNotFoundFilter } from './not-found.filter';

/**
 * In-memory E2E for the unified Smart Import endpoint (#477):
 * preview + commit for each of the four destinations, idempotency, the
 * program-spec custom-program guard, and the low-confidence path.
 */
describe('Smart Import HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    // main.ts registers @fastify/multipart in production; NestFactory.create here
    // bypasses that bootstrap, so register it explicitly for the upload endpoint.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(multipart as any, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    app.useGlobalFilters(new DomainNotFoundFilter());
    // Was `{ whitelist: true }` only — didn't match main.ts's production pipe.
    // Sourced from the shared constant so it can't silently diverge (#893 review).
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const AUTH = { authorization: 'Bearer dev-token' };
  const UUID_PROGRAM = '11111111-1111-1111-1111-111111111111';

  const importCsv = (program: string, csv: string, query = '') => {
    const boundary = '----SmartImportBoundary';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="upload.csv"',
      'Content-Type: text/csv',
      '',
      csv,
      `--${boundary}--`,
    ].join('\r\n');
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/programs/${encodeURIComponent(program)}/import${query}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...AUTH },
      payload,
    });
  };

  const LIFT_CSV = [
    'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
    '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,',
  ].join('\n');

  // Two rows sharing every field except date — the exact shape of issue #884's
  // real-world collisions (e.g. a cycle-numbering reset reusing cycle/workout/set
  // combos years apart). Both must be created; neither may silently collapse.
  const LIFT_CSV_SAME_KEY_DIFFERENT_DATE = [
    'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
    '5-3-1,1,1,2025-12-16,Bench P.,1,175,7,',
    '5-3-1,1,1,2024-01-12,Bench P.,1,202.5,8,',
  ].join('\n');

  const TM_CSV = ['Date Updated,Lift,Weight', '12/29/2025,Bench P.,182.5'].join('\n');

  const GOALS_CSV = [
    'Weight,175,,,',
    'Start Date,10/24/2022,,,',
    "Today's Date,6/9/2026,,,",
    'Lift,Current TM,Intermediate,Advanced,Elite',
    'Squat,250,280,350,420',
    'Bench P.,185,210,262.5,315',
    'Chin-up,252.5,210,262.5,315',
    'Deadlift,287.5,350,437.5,525',
    'OH Press,110,131.25,175,218.75',
  ].join('\n');

  const SPEC_CSV = [
    'Week,Offset,Lift,Increment,Order,Sets,Reps,AMRAP?,Warm-Up %,WT Decrement %,Activation',
    '1,0,Bench P.,2.5,1,3,8,TRUE,.6,0.05,Band Flye',
  ].join('\n');

  describe('preview (mode=preview) classifies and writes nothing', () => {
    it('routes a lift-history file to lift-records with a create preview', async () => {
      const res = await importCsv('import-lr-prev', LIFT_CSV, '?mode=preview');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.classification.type).toBe('lift-records');
      expect(body.destination).toBe('lift-records');
      expect(body.preview.creates).toBe(1);
    });

    // Regression guard (#911 review, fourth pass): a CSV whose exercise
    // column is named something other than "Lift" (the case the MAP_COLUMNS
    // step exists to let a user fix) leaves r.lift undefined on every row —
    // distinct from a present-but-blank cell (''). A bare cast + .trim() (the
    // third review pass's own trim-for-parity fix) threw a TypeError on that
    // undefined instead of falling through to the ambiguous bucket, turning
    // this recoverable case into a 500 with no way to reach MAP_COLUMNS at all.
    it('previews a lift-records file whose exercise column is not named "Lift" without a 500, flagging every row ambiguous', async () => {
      const nonStandardCsv = [
        'Program,Cycle #,Workout #,Date,Exercise,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,',
      ].join('\n');
      const res = await importCsv(
        'import-lr-nocol',
        nonStandardCsv,
        '?mode=preview&destination=lift-records',
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.errors).toEqual([]);
      expect(body.preview.deltas).toHaveLength(1);
      expect(body.preview.deltas[0]).toMatchObject({ status: 'ambiguous' });
    });

    it('routes a training-maxes file to training-maxes', async () => {
      const body = (await importCsv('import-tm-prev', TM_CSV, '?mode=preview')).json();
      expect(body.destination).toBe('training-maxes');
      expect(body.preview.creates).toBe(1);
    });

    it('routes a tier-ladder strength-goals file to strength-goals', async () => {
      const body = (await importCsv('import-sg-prev', GOALS_CSV, '?mode=preview')).json();
      expect(body.destination).toBe('strength-goals');
      expect(body.preview.creates).toBe(5);
    });

    it('routes a program-spec file to program-spec', async () => {
      const body = (await importCsv(UUID_PROGRAM, SPEC_CSV, '?mode=preview')).json();
      expect(body.destination).toBe('program-spec');
      expect(body.preview.creates).toBe(1);
    });

    it('returns a null destination and preview for an ambiguous file', async () => {
      const body = (
        await importCsv('import-amb', 'Foo,Bar\n1,2\n3,4', '?mode=preview')
      ).json();
      expect(body.classification.type).toBeNull();
      expect(body.destination).toBeNull();
      expect(body.preview).toBeNull();
    });
  });

  describe('commit (mode=commit) writes idempotently', () => {
    it('commits lift records and is idempotent on re-run', async () => {
      const first = (
        await importCsv('import-lr', LIFT_CSV, '?mode=commit&destination=lift-records')
      ).json();
      expect(first).toMatchObject({ destination: 'lift-records', created: 1 });
      // Nothing skipped on the first commit — detail list is present but empty (issue #891).
      expect(first.skippedDetail).toEqual([]);
      const second = (
        await importCsv('import-lr', LIFT_CSV, '?mode=commit&destination=lift-records')
      ).json();
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(1);
      // Row 1 is the only (and thus 1-based-first) data row in LIFT_CSV.
      expect(second.skippedDetail).toEqual([
        { row: 1, naturalKey: '1:1:20260101:bench-press:1' },
      ]);
    });

    // Regression for issue #884: before the fix, both rows shared a date-less
    // key and the second silently collapsed into the first. Re-committing the
    // identical file afterward — the same idempotency check the sibling test
    // above uses — proves both rows actually persisted: if only one had been
    // written, the re-run would show created:1, skipped:1 instead of skipped:2.
    it('creates both rows when they share every field except date', async () => {
      const first = (
        await importCsv(
          'import-lr-datekey',
          LIFT_CSV_SAME_KEY_DIFFERENT_DATE,
          '?mode=commit&destination=lift-records',
        )
      ).json();
      expect(first).toMatchObject({ destination: 'lift-records', created: 2, skipped: 0 });

      const second = (
        await importCsv(
          'import-lr-datekey',
          LIFT_CSV_SAME_KEY_DIFFERENT_DATE,
          '?mode=commit&destination=lift-records',
        )
      ).json();
      expect(second).toMatchObject({ created: 0, skipped: 2 });
      // Both rows are reported by row number and full (date-inclusive) natural key.
      expect(second.skippedDetail).toEqual([
        { row: 1, naturalKey: '1:1:20251216:bench-press:1' },
        { row: 2, naturalKey: '1:1:20240112:bench-press:1' },
      ]);
    });

    it('commits training maxes and is idempotent on re-run', async () => {
      const first = (
        await importCsv('import-tm', TM_CSV, '?mode=commit&destination=training-maxes')
      ).json();
      expect(first.created).toBe(1);
      const second = (
        await importCsv('import-tm', TM_CSV, '?mode=commit&destination=training-maxes')
      ).json();
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(1);
      // skippedDetail is a lift-records-only field (issue #891) — absent here, not [].
      expect(second.skippedDetail).toBeUndefined();
    });

    it('commits strength goals and is idempotent on re-run', async () => {
      const first = (
        await importCsv('import-sg', GOALS_CSV, '?mode=commit&destination=strength-goals')
      ).json();
      expect(first.created).toBe(5);
      const second = (
        await importCsv('import-sg', GOALS_CSV, '?mode=commit&destination=strength-goals')
      ).json();
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(5);
    });

    it('commits a program spec to a custom program and is idempotent', async () => {
      const first = (
        await importCsv(UUID_PROGRAM, SPEC_CSV, '?mode=commit&destination=program-spec')
      ).json();
      expect(first).toMatchObject({ destination: 'program-spec', created: 1 });
      const second = (
        await importCsv(UUID_PROGRAM, SPEC_CSV, '?mode=commit&destination=program-spec')
      ).json();
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(1);
    });

    it('preserves training maxes for lifts absent from a partial import', async () => {
      const program = 'import-tm-partial';
      await importCsv(
        program,
        ['Date Updated,Lift,Weight', '12/29/2025,Bench P.,182.5', '12/29/2025,Squat,300'].join('\n'),
        '?mode=commit&destination=training-maxes',
      );
      // Re-import only Bench P. at a new value; Squat is omitted.
      const res = (
        await importCsv(
          program,
          ['Date Updated,Lift,Weight', '1/2/2026,Bench P.,185'].join('\n'),
          '?mode=commit&destination=training-maxes',
        )
      ).json();
      expect(res.updated).toBe(1);
      const maxes = (
        await app.getHttpAdapter().getInstance().inject({
          method: 'GET',
          url: `/programs/${program}/training-maxes`,
          headers: AUTH,
        })
      ).json() as Array<{ lift: string; weight: number }>;
      // Lift names are resolved to canonical slot-map IDs on import
      // ("Squat" → "back-squat", "Bench P." → "bench-press").
      const byLift = Object.fromEntries(maxes.map((m) => [m.lift, m.weight]));
      expect(byLift['back-squat']).toBe(300); // omitted lift survives
      expect(byLift['bench-press']).toBe(185); // imported lift updated
    });

    it('rejects a program-spec commit to a built-in (non-UUID) program', async () => {
      const res = await importCsv('5-3-1', SPEC_CSV, '?mode=commit&destination=program-spec');
      expect(res.statusCode).toBe(400);
    });

    it('rejects a commit with no destination', async () => {
      const res = await importCsv('import-lr', LIFT_CSV, '?mode=commit');
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Phase 3 — liftOverrides, excludeKeys, splitDest, and undo', () => {
    const undoImport = (program: string, batchId: string) =>
      app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${encodeURIComponent(program)}/import/${batchId}/undo`,
        headers: AUTH,
      });

    // Lift name not in DEFAULT_SLOT_MAP — strict validation rejects without an override
    const AMBIGUOUS_LIFT_CSV = [
      'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
      '5-3-1,1,1,2026-01-01,NOT_IN_SLOT_MAP,1,180,5,',
    ].join('\n');

    // Two rows: one normal lift-record, one with a 1RM note → should route to training-maxes
    const SPLIT_CSV = [
      'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
      '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,',
      '5-3-1,1,1,2026-01-01,Squat,1,250,1,1RM Test',
    ].join('\n');

    it('commits an ambiguous-lift row when liftOverrides remaps it before validation', async () => {
      const overrides = encodeURIComponent(JSON.stringify({ '1': 'bench-press' }));
      const res = (
        await importCsv(
          'p3-lr-override',
          AMBIGUOUS_LIFT_CSV,
          `?mode=commit&destination=lift-records&liftOverrides=${overrides}`,
        )
      ).json();
      expect(res.created).toBe(1);

      // Without the override the same row fails strict validation
      const failRes = await importCsv(
        'p3-lr-override-fail',
        AMBIGUOUS_LIFT_CSV,
        '?mode=commit&destination=lift-records',
      );
      expect(failRes.statusCode).toBe(400);
    });

    // Regression guard (#911 review, fourth pass, resolving issue #915 for
    // its only real trigger surface): an ambiguous row's excludeKeys entry
    // uses the client's `__ambiguous_<rowIndex>` key scheme, which can never
    // equal a natural key — the natural-key excludeKeys filter alone can
    // never omit it. Before this fix the excluded-but-unresolved row reached
    // strict validation and failed the WHOLE commit (a regression the third
    // review pass's own liftOverrides-withholding fix introduced, worse than
    // #915's original silent-bad-import symptom).
    it('commits successfully when an ambiguous row is excluded via excludeKeys, omitting only that row', async () => {
      const twoRowCsv = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,',
        '5-3-1,1,1,2026-01-01,NOT_IN_SLOT_MAP,1,200,5,',
      ].join('\n');
      const res = await importCsv(
        'p3-lr-exclude-ambiguous',
        twoRowCsv,
        '?mode=commit&destination=lift-records&excludeKeys=__ambiguous_2',
      );
      expect(res.statusCode).toBe(200);
      // Only row 1 (Bench P.) committed — row 2 was excluded, not merely left
      // unresolved, so it must not block or appear in the commit at all.
      expect(res.json().created).toBe(1);
    });

    // Regression guard (#911 review, fifth pass): __incomplete_N shares the
    // identical never-matches-a-natural-key problem __ambiguous_N had — an
    // earlier version of the fix above (fourth pass) covered only
    // __ambiguous_, missing this sibling key family entirely.
    it('commits successfully when an incomplete row is excluded via excludeKeys, omitting only that row', async () => {
      const twoRowCsv = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,',
        '5-3-1,1,1,2026-01-01,Bench P.,1,NOT_A_NUMBER,5,',
      ].join('\n');
      const res = await importCsv(
        'p3-lr-exclude-incomplete',
        twoRowCsv,
        '?mode=commit&destination=lift-records&excludeKeys=__incomplete_2',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().created).toBe(1);
    });

    // Regression guard (#911 review, fifth pass): excluding a row shortens
    // the array validateLiftImport numbers positionally — without correcting
    // for that, a validation error on a row AFTER the excluded one reports
    // the wrong (post-filter, shifted-down) row number, pointing the user at
    // the wrong line in their actual CSV file.
    it('reports the original (pre-exclusion) row number in a validation error after an earlier row was excluded', async () => {
      const threeRowCsv = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-01,NOT_IN_SLOT_MAP,1,180,5,', // row 1: ambiguous, excluded
        '5-3-1,1,1,2026-01-01,Bench P.,2,180,5,', // row 2: valid
        '5-3-1,1,1,2026-01-01,Bench P.,3,NOT_A_NUMBER,5,', // row 3: invalid weight, NOT excluded
      ].join('\n');
      const res = await importCsv(
        'p3-lr-exclude-row-numbering',
        threeRowCsv,
        '?mode=commit&destination=lift-records&excludeKeys=__ambiguous_1',
      );
      expect(res.statusCode).toBe(400);
      const body = res.json() as { errors: { row: number; field: string }[] };
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ row: 3, field: 'weight' })]),
      );
      // Must not report the post-filter array position (2) instead of the
      // row's actual original position in the uploaded CSV (3).
      expect(body.errors.some((e) => e.row === 2)).toBe(false);
    });

    const createCustomLift = (body: unknown) =>
      app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/lifts/custom',
        headers: { 'content-type': 'application/json', ...AUTH },
        payload: JSON.stringify(body),
      });

    // #911: the slot map used for both preview and commit is now built fresh per
    // request from DEFAULT_SLOT_MAP + the user's custom lifts, so a CSV row whose
    // raw text already matches an existing custom lift's name resolves immediately.
    it('recognizes an existing custom lift by name at preview time — no longer ambiguous', async () => {
      const created = await createCustomLift({
        name: 'Wide-Grip CBL Curls',
        classification: 'accessory',
      });
      expect(created.statusCode).toBe(201);

      const CUSTOM_LIFT_CSV = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-01,Wide-Grip CBL Curls,1,90,10,',
      ].join('\n');
      // destination is passed explicitly (as the Wizard itself does once a
      // destination is confirmed) rather than relying on auto-classification —
      // classifyImport's own confidence heuristic runs BEFORE the custom-lift-aware
      // slot map is ever built, so it has no way to know this row's raw text is a
      // recognized custom lift; that resolution is previewLiftRecords' job, not
      // classification's, and this test is about the former.
      const res = (
        await importCsv(
          'p3-custom-lift-preview',
          CUSTOM_LIFT_CSV,
          '?mode=preview&destination=lift-records',
        )
      ).json();
      // Array.prototype.every returns true on an empty array — asserting only
      // "no delta is ambiguous" would pass just as well if the row vanished
      // entirely (dropped, or a hard-error response with no preview at all),
      // which is not what "resolves instead of being ambiguous" means. Assert
      // the row actually exists, resolved, in the expected shape (#911 review,
      // second pass).
      expect(res.errors).toEqual([]);
      expect(res.preview).not.toBeNull();
      expect(res.preview.deltas).toHaveLength(1);
      expect(res.preview.deltas[0]).toMatchObject({ kind: 'create' });
      expect(res.preview.deltas[0].status).not.toBe('ambiguous');
    });

    // #911: liftOverrides may now resolve to a custom lift's id (not just a
    // built-in canonical id) — the self-mapping half of buildEffectiveSlotMap
    // must let an already-resolved custom-lift id pass strict validation.
    it('commits when liftOverrides references an existing custom lift id', async () => {
      const created = await createCustomLift({
        name: 'Custom Commit Lift',
        classification: 'accessory',
      });
      // Asserted before destructuring (review finding on #911's PR): if creation
      // ever regresses, customLiftId would silently be undefined, dropping the
      // liftOverrides key entirely and failing on the unrelated `created` assertion
      // below instead of pointing at this setup step.
      expect(created.statusCode).toBe(201);
      const { id: customLiftId } = created.json();

      const overrides = encodeURIComponent(JSON.stringify({ '1': customLiftId }));
      const res = (
        await importCsv(
          'p3-lr-custom-id-override',
          AMBIGUOUS_LIFT_CSV,
          `?mode=commit&destination=lift-records&liftOverrides=${overrides}`,
        )
      ).json();
      expect(res.created).toBe(1);
    });

    // #914: the slot map used for training-maxes preview/commit is now built fresh
    // per request from DEFAULT_SLOT_MAP + the user's custom lifts too (previously
    // only lift-records was custom-lift-aware, #911) — a CSV row whose raw text
    // matches an existing custom lift's name resolves to that lift's id instead of
    // passing through as raw display text. buildTrainingMaxPreview's delta `label`
    // carries the resolved `lift` value, so asserting on it proves resolution
    // without needing a separate read endpoint.
    it('resolves an existing custom lift by name for a training-maxes import', async () => {
      const created = await createCustomLift({
        name: 'TM Import Custom Lift',
        classification: 'compound',
      });
      expect(created.statusCode).toBe(201);
      const { id: customLiftId } = created.json();

      const CUSTOM_LIFT_TM_CSV = [
        'Date Updated,Lift,Weight',
        '12/29/2025,TM Import Custom Lift,90',
      ].join('\n');
      const res = (
        await importCsv(
          'p3-custom-lift-tm-preview',
          CUSTOM_LIFT_TM_CSV,
          '?mode=preview&destination=training-maxes',
        )
      ).json();
      expect(res.errors).toEqual([]);
      expect(res.preview).not.toBeNull();
      expect(res.preview.deltas).toHaveLength(1);
      expect(res.preview.deltas[0]).toMatchObject({ kind: 'create', label: customLiftId });
    });

    // Same as above, for strength-goals (buildStrengthGoalPreview's delta `label`
    // also carries the resolved `lift` value).
    it('resolves an existing custom lift by name for a strength-goals import', async () => {
      const created = await createCustomLift({
        name: 'Goal Import Custom Lift',
        classification: 'compound',
      });
      expect(created.statusCode).toBe(201);
      const { id: customLiftId } = created.json();

      const CUSTOM_LIFT_GOALS_CSV = [
        'Weight,175,,,',
        'Start Date,10/24/2022,,,',
        "Today's Date,6/9/2026,,,",
        'Lift,Current TM,Intermediate,Advanced,Elite',
        'Goal Import Custom Lift,90,105,131.25,157.5',
      ].join('\n');
      const res = (
        await importCsv(
          'p3-custom-lift-goals-preview',
          CUSTOM_LIFT_GOALS_CSV,
          '?mode=preview&destination=strength-goals',
        )
      ).json();
      expect(res.errors).toEqual([]);
      expect(res.preview).not.toBeNull();
      expect(res.preview.deltas).toHaveLength(1);
      expect(res.preview.deltas[0]).toMatchObject({ kind: 'create', label: customLiftId });
    });

    // #914: this splitDest interaction was the second trigger discovered for this
    // issue (see effective-slot-map.util.ts's doc comment) — a splitDest commit
    // partitions a 1RM-noted lift-records row into a training-max write already
    // keyed by the row's resolved custom-lift id (lift-records has been
    // custom-lift-aware since #911). Before #914, a *separate* direct
    // training-maxes import of the same lift by display name would key it
    // differently (raw display text, since validateTrainingMaxImport wasn't yet
    // custom-lift-aware) — creating a duplicate entry instead of updating the one
    // the splitDest commit already wrote. Both paths must now agree.
    it('keys a splitDest training max the same way a direct training-maxes import of the same custom lift would', async () => {
      const program = 'p3-split-tm-custom-lift-parity';
      const created = await createCustomLift({
        name: 'Custom Front Squat',
        classification: 'compound',
      });
      expect(created.statusCode).toBe(201);
      const { id: customLiftId } = created.json();

      // Step 1: a splitDest lift-records commit with a 1RM-noted row for the
      // custom lift — partitions into training-maxes, keyed by the row's
      // already-resolved custom-lift id.
      const SPLIT_CUSTOM_LIFT_CSV = [
        'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes',
        '5-3-1,1,1,2026-01-01,Custom Front Squat,1,300,1,1RM Test',
      ].join('\n');
      const splitRes = (
        await importCsv(
          program,
          SPLIT_CUSTOM_LIFT_CSV,
          '?mode=commit&destination=lift-records&splitDest=1',
        )
      ).json();
      expect(splitRes.split).toMatchObject({ destination: 'training-maxes', created: 1 });

      // Step 2: a direct training-maxes import naming the SAME custom lift by its
      // display name, with a different weight — must UPDATE the entry the
      // splitDest commit already created (same key), not create a second,
      // differently-keyed one.
      const DIRECT_TM_CSV = ['Date Updated,Lift,Weight', '1/2/2026,Custom Front Squat,315'].join('\n');
      const directRes = (
        await importCsv(program, DIRECT_TM_CSV, '?mode=commit&destination=training-maxes')
      ).json();
      expect(directRes).toMatchObject({ created: 0, updated: 1 });

      // Exactly one training max exists for this program, keyed by the custom
      // lift's id, holding the direct import's weight (315) — proving both paths
      // resolved to the same key rather than creating two entries.
      const maxes = (
        await app.getHttpAdapter().getInstance().inject({
          method: 'GET',
          url: `/programs/${program}/training-maxes`,
          headers: AUTH,
        })
      ).json() as Array<{ lift: string; weight: number }>;
      expect(maxes).toHaveLength(1);
      expect(maxes[0]).toMatchObject({ lift: customLiftId, weight: 315 });
    });

    it('excludes rows whose natural key matches excludeKeys', async () => {
      // Natural key for LIFT_CSV row: cycleNum:workoutNum:YYYYMMDD:lift:setNum
      // = 1:1:20260101:bench-press:1 (date joined the key in issue #884)
      const excludeParam = encodeURIComponent('1:1:20260101:bench-press:1');
      const res = (
        await importCsv(
          'p3-lr-exclude',
          LIFT_CSV,
          `?mode=commit&destination=lift-records&excludeKeys=${excludeParam}`,
        )
      ).json();
      // Row was excluded — nothing created and nothing skipped
      expect(res.created).toBe(0);
      expect(res.skipped).toBe(0);
      expect(res.batchId).toBeTruthy();
      // The excluded row never reaches the classification pass, so it has no
      // skip detail entry either — excluded is not the same thing as skipped.
      expect(res.skippedDetail).toEqual([]);
    });

    it('routes 1RM rows to training-maxes without double-writing them as lift-records', async () => {
      const res = (
        await importCsv(
          'p3-lr-split',
          SPLIT_CSV,
          '?mode=commit&destination=lift-records&splitDest=1',
        )
      ).json();
      // Only the Bench P. row goes to lift-records; Squat 1RM goes to training-maxes only
      expect(res.created).toBe(1);
      expect(res.split).toMatchObject({ destination: 'training-maxes', created: 1 });
      expect(res.skippedDetail).toEqual([]);

      // Re-commit: Bench P. lift-record is skipped; Squat TM is also skipped — not created again
      const reCommit = (
        await importCsv(
          'p3-lr-split',
          SPLIT_CSV,
          '?mode=commit&destination=lift-records&splitDest=1',
        )
      ).json();
      expect(reCommit.skipped).toBe(1); // Bench P. as lift-record
      expect(reCommit.split).toMatchObject({ destination: 'training-maxes', skipped: 1 });
      // Squat was split away before reaching the lift-records commit path, so Bench
      // P. is the only (and thus row-1) entry in the batch skippedDetail reports
      // against — see ImportCommitResponse.skippedDetail on row numbering after
      // splitDest/excludeKeys filtering.
      expect(reCommit.skippedDetail).toEqual([
        { row: 1, naturalKey: '1:1:20260101:bench-press:1' },
      ]);
    });

    it('undoes a created lift-record by deleting it', async () => {
      const commitRes = (
        await importCsv('p3-undo-lr', LIFT_CSV, '?mode=commit&destination=lift-records')
      ).json();
      expect(commitRes.created).toBe(1);
      const { batchId } = commitRes;

      const undoRes = (await undoImport('p3-undo-lr', batchId)).json();
      expect(undoRes.restored).toBe(1);
      expect(undoRes.skipped).toBe(0);
      expect(undoRes.flagged).toEqual([]);

      // After undo the row is gone — re-commit creates it again instead of skipping
      const reCommit = (
        await importCsv('p3-undo-lr', LIFT_CSV, '?mode=commit&destination=lift-records')
      ).json();
      expect(reCommit.created).toBe(1);
    });

    it('undoes an updated training max by restoring the prior weight', async () => {
      const program = 'p3-undo-tm';
      await importCsv(program, TM_CSV, '?mode=commit&destination=training-maxes');

      const TM_CSV_185 = ['Date Updated,Lift,Weight', '1/2/2026,Bench P.,185'].join('\n');
      const updateRes = (
        await importCsv(program, TM_CSV_185, '?mode=commit&destination=training-maxes')
      ).json();
      expect(updateRes.updated).toBe(1);
      const { batchId } = updateRes;

      const undoRes = (await undoImport(program, batchId)).json();
      expect(undoRes.restored).toBe(1);
      expect(undoRes.skipped).toBe(0);

      const maxes = (
        await app.getHttpAdapter().getInstance().inject({
          method: 'GET',
          url: `/programs/${program}/training-maxes`,
          headers: AUTH,
        })
      ).json() as Array<{ lift: string; weight: number }>;
      const byLift = Object.fromEntries(maxes.map((m) => [m.lift, m.weight]));
      expect(byLift['bench-press']).toBe(182.5); // restored to the value before the update
    });

    it('skips undo and flags when a training max was modified after the import', async () => {
      const program = 'p3-undo-tm-guard';
      // Step 1: create at 182.5
      await importCsv(program, TM_CSV, '?mode=commit&destination=training-maxes');
      // Step 2: update to 185 — this is the batch we will try to undo
      const TM_CSV_185 = ['Date Updated,Lift,Weight', '1/2/2026,Bench P.,185'].join('\n');
      const updateRes = (
        await importCsv(program, TM_CSV_185, '?mode=commit&destination=training-maxes')
      ).json();
      const batchId = updateRes.batchId;
      // Step 3: update to 190 — now the current value (190) no longer matches what
      // batchId wrote (185), so the post-edit guard must fire on undo
      const TM_CSV_190 = ['Date Updated,Lift,Weight', '1/3/2026,Bench P.,190'].join('\n');
      await importCsv(program, TM_CSV_190, '?mode=commit&destination=training-maxes');

      const undoRes = (await undoImport(program, batchId)).json();
      expect(undoRes.restored).toBe(0);
      expect(undoRes.skipped).toBe(1);
      expect(undoRes.flagged).toHaveLength(1);
      expect(undoRes.flagged[0].key).toBe('bench-press');
      expect(undoRes.flagged[0].reason).toContain('modified after import');
    });
  });
});
