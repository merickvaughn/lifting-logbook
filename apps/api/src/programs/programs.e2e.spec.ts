import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { InMemoryRepositoryFactory } from '../adapters/factory/in-memory-repository-factory';
import { InMemoryUserSettingsRepository } from '../adapters/in-memory/user-settings.adapter';
import { SEED_PROGRAM } from '../adapters/in-memory/fixtures';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainNotFoundFilter } from './not-found.filter';

describe('Programs HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new DomainNotFoundFilter());
    // Was `{ whitelist: true }` only — didn't match main.ts's production pipe (which
    // also sets forbidNonWhitelisted), so this harness could never actually prove an
    // unrecognized body field is rejected over HTTP the way it really is in
    // production. Now sourced from the same shared constant main.ts uses, so the two
    // cannot silently diverge again (found during #893's review).
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const AUTH = { authorization: 'Bearer dev-token' };

  const get = (url: string) =>
    app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers: AUTH });

  const post = (url: string) =>
    app.getHttpAdapter().getInstance().inject({ method: 'POST', url, headers: AUTH });

  const postJson = (url: string, body: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...AUTH },
      payload: JSON.stringify(body),
    });

  const patchJson = (url: string, body: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'PATCH',
      url,
      headers: { 'content-type': 'application/json', ...AUTH },
      payload: JSON.stringify(body),
    });

  const putJson = (url: string, body: unknown) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url,
      headers: { 'content-type': 'application/json', ...AUTH },
      payload: JSON.stringify(body),
    });

  const deleteReq = (url: string) =>
    app.getHttpAdapter().getInstance().inject({ method: 'DELETE', url, headers: AUTH });

  it('GET /health returns ok without auth', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /programs/:program/cycles/current returns 401 without auth', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: `/programs/${SEED_PROGRAM}/cycles/current` });
    expect(res.statusCode).toBe(401);
  });

  it('GET /programs/:program/cycles/current returns the seeded cycle', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.program).toBe(SEED_PROGRAM);
    expect(body.cycleNum).toBe(1);
    expect(body.cycleStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('GET /programs/:program/workouts/:workoutNum returns grouped lifts', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/workouts/1`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workoutNum).toBe(1);
    expect(body.lifts.length).toBeGreaterThan(0);
  });

  it('GET /programs/:program/workouts/:workoutNum resolves a tiled week-2 workout in no-schedule mode (issue #740)', async () => {
    // The seeded 5-3-1 program is a 3-week block of offsets {0,3} but a canonical
    // length of 12 weeks, and the seeded user has no workout schedule. Workout 3 is
    // the first workout of week 2. Pre-#740 the no-schedule cap was the block's 2
    // distinct offsets, so this 400'd; now it tiles to the full length and resolves.
    const res = await get(`/programs/${SEED_PROGRAM}/workouts/3`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workoutNum).toBe(3);
    expect(body.week).toBe(2);
    expect(body.lifts.length).toBeGreaterThan(0);
  });

  it('GET /programs/:program/training-maxes returns the seeded maxes', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/training-maxes`);
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('GET /programs/:program/lift-records returns records for current cycle', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/lift-records`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.every((r: { cycleNum: number }) => r.cycleNum === 1)).toBe(true);
  });

  it('GET /programs/:program/spec returns the seeded program spec', async () => {
    const res = await get(`/programs/${SEED_PROGRAM}/spec`);
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('GET /programs/rpt/spec returns the full seeded RPT spec (regression: issue #739)', async () => {
    // `rpt` was added to PRESET_BASE_SPECS in #596 but never seeded into the
    // in-memory adapter, so this endpoint silently returned [] for every
    // onboarded RPT user. The RPT split is 9 rows across 3 workout days
    // (offsets 0/2/4), each a distinct lift.
    const res = await get('/programs/rpt/spec');
    expect(res.statusCode).toBe(200);
    const rows: { offset: number; lift: string }[] = res.json();
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.offset))).toEqual(new Set([0, 2, 4]));
    expect(new Set(rows.map((r) => r.lift)).size).toBe(9);
  });

  it('GET unknown program returns 404', async () => {
    const res = await get('/programs/does-not-exist/cycles/current');
    expect(res.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Workout reschedule (read-compatible: uses seeded cycle 1 data)
  // Run before write operations so cycleNum is still 1.
  // ---------------------------------------------------------------------------

  describe('workout reschedule', () => {
    const RESCHEDULE_URL = `/programs/${SEED_PROGRAM}/cycles/1/workouts/1/reschedule`;

    it('PATCH reschedule returns 204 No Content', async () => {
      const res = await patchJson(RESCHEDULE_URL, { newDate: '2026-06-01' });
      expect(res.statusCode).toBe(204);
    });

    it('GET workout after reschedule includes overrideDate', async () => {
      await patchJson(RESCHEDULE_URL, { newDate: '2026-06-01' });
      const res = await get(`/programs/${SEED_PROGRAM}/workouts/1`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.overrideDate).toBe('2026-06-01');
    });

    it('PATCH reschedule with invalid date returns 400', async () => {
      const res = await patchJson(RESCHEDULE_URL, { newDate: 'not-a-date' });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH reschedule with invalid workoutNum returns 400', async () => {
      const res = await patchJson(
        `/programs/${SEED_PROGRAM}/cycles/1/workouts/0/reschedule`,
        { newDate: '2026-06-01' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('PATCH reschedule with out-of-range workoutNum returns 400', async () => {
      // 9999 is a positive integer (passes the old check) but far past the
      // program's canonical length — an override there is dead data.
      const res = await patchJson(
        `/programs/${SEED_PROGRAM}/cycles/1/workouts/9999/reschedule`,
        { newDate: '2026-06-01' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('PATCH reschedule with non-active cycleNum returns 400', async () => {
      // Seed's active cycle is 1 (these tests run before any new-cycle writes).
      // Cycle 2 is not the active cycle, so an override there could never be read.
      const res = await patchJson(
        `/programs/${SEED_PROGRAM}/cycles/2/workouts/1/reschedule`,
        { newDate: '2026-06-01' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('PATCH reschedule requires auth', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
        app.getHttpAdapter().getInstance(),
      );
      const res = await injectRaw({ method: 'PATCH', url: RESCHEDULE_URL });
      expect(res.statusCode).toBe(401);
    });

    it('PATCH reschedule with unknown program returns 404', async () => {
      const res = await patchJson(
        `/programs/no-such-program/cycles/1/workouts/1/reschedule`,
        { newDate: '2026-06-01' },
      );
      expect(res.statusCode).toBe(404);
    });

    it('PATCH reschedule with datetime string returns 400', async () => {
      const res = await patchJson(RESCHEDULE_URL, { newDate: '2026-06-01T12:00:00Z' });
      expect(res.statusCode).toBe(400);
    });

    it('isolates reschedule overrides between users', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
        app.getHttpAdapter().getInstance(),
      );
      // Alice is the pre-seeded dev user (has a cycle dashboard); Bob is a fresh user.
      const AS_ALICE = AUTH;
      const AS_BOB   = { authorization: 'Bearer user-bob-reschedule' };

      // Alice reschedules workout 1 of cycle 1
      const patchRes = await injectRaw({
        method: 'PATCH',
        url: RESCHEDULE_URL,
        headers: { 'content-type': 'application/json', ...AS_ALICE },
        payload: JSON.stringify({ newDate: '2026-08-15' }),
      });
      expect(patchRes.statusCode).toBe(204);

      // Bob reads the same workout — his bundle is independent; Alice's override must not appear
      const bobWorkout = await injectRaw({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/workouts/1`,
        headers: AS_BOB,
      });
      expect(bobWorkout.statusCode).toBe(200);
      expect(bobWorkout.json().overrideDate).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Write endpoints — order-sensitive; each test mutates singleton adapter
  // state and the next test observes that state. Do not reorder or randomize.
  // -------------------------------------------------------------------------

  describe('write operations', () => {
    it('POST /programs/:program/training-maxes/recalculate flags reductions and returns { maxes, flagged }', async () => {
      // Capture seeded Squat max before recalculate (cycle 1 has Squat records)
      const beforeRes = await get(`/programs/${SEED_PROGRAM}/training-maxes`);
      const squatBefore = beforeRes
        .json()
        .find((m: { lift: string }) => m.lift === 'Squat').weight;

      const res = await post(`/programs/${SEED_PROGRAM}/training-maxes/recalculate`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.maxes)).toBe(true);
      expect(body.maxes.length).toBeGreaterThan(0);
      expect(Array.isArray(body.flagged)).toBe(true);
      for (const m of body.maxes) {
        expect(m).toMatchObject({
          lift: expect.any(String),
          weight: expect.any(Number),
          unit: 'lbs',
          dateUpdated: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        });
      }
      // Cycle-1 Squat set 1 was logged at 205 lbs → proposed max 210 < seeded TM 315.
      // Reduction must be flagged, not auto-applied; TM is unchanged.
      const squatFlag = body.flagged.find((f: { lift: string }) => f.lift === 'Squat');
      expect(squatFlag).toBeDefined();
      expect(squatFlag.currentWeight).toBe(squatBefore);
      expect(squatFlag.proposedWeight).toBe(210); // 205 + increment 5
      const squatAfter = body.maxes.find((m: { lift: string }) => m.lift === 'Squat').weight;
      expect(squatAfter).toBe(squatBefore); // max unchanged
    });

    it('POST /programs/:program/cycles advances cycleNum and persists new maxes', async () => {
      // Pre-condition: recalculate does not advance the cycle; counter is still 1
      expect((await get(`/programs/${SEED_PROGRAM}/cycles/current`)).json().cycleNum).toBe(1);

      const res = await post(`/programs/${SEED_PROGRAM}/cycles`);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.program).toBe(SEED_PROGRAM);
      // Cycle counter must have advanced from the seeded value of 1
      expect(body.cycleNum).toBe(2);
      expect(body.cycleStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Verify the persisted dashboard is readable via GET
      const getRes = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().cycleNum).toBe(2);
    });

    it('POST /programs/:program/cycles with fromCycleNum uses that cycle\'s records', async () => {
      // Pre-condition: cycle is at 2 (advanced by previous test).
      // fromCycleNum=1 re-pins "advance from cycle 1", producing cycleNum=2 again — not normal
      // advancement, but confirms that fromCycleNum overrides the current counter.
      expect((await get(`/programs/${SEED_PROGRAM}/cycles/current`)).json().cycleNum).toBe(2);
      const res = await postJson(`/programs/${SEED_PROGRAM}/cycles`, { fromCycleNum: 1 });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.cycleNum).toBe(2);
      expect(body.cycleStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('POST /programs/:program/cycles with cycleDate pins the new cycle\'s start date', async () => {
      // Pre-condition: fromCycleNum re-pinned cycle to 2; advancing normally moves it to 3.
      expect((await get(`/programs/${SEED_PROGRAM}/cycles/current`)).json().cycleNum).toBe(2);
      const res = await postJson(`/programs/${SEED_PROGRAM}/cycles`, {
        cycleDate: '2026-06-01',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().cycleStartDate).toBe('2026-06-01');
    });

    it('POST /programs/:program/cycles with fromCycleNum having no records returns 400', async () => {
      const res = await postJson(`/programs/${SEED_PROGRAM}/cycles`, { fromCycleNum: 99 });
      expect(res.statusCode).toBe(400);
    });

    it('POST /programs/unknown/cycles returns 404', async () => {
      const res = await post('/programs/does-not-exist/cycles');
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-workout progression scenario — order-sensitive, continues from the
  // state left by 'write operations' above: cycleNum=3, dev-token user.
  //
  // TMs after write operations (deterministic trace):
  //   Squat:          315 lbs  (cycle-1 set-1 was 205 lbs → proposed 210 < 315 → flagged, not applied)
  //   Bench Press:    225 lbs  (no cycle-1 Bench records; unchanged from seed)
  //   Deadlift:       405 lbs  (no cycle-1 DL records; unchanged from seed)
  //   Overhead Press: 145 lbs  (no cycle-1 OHP records; unchanged from seed)
  //
  // Cycle 3 records logged below use dates newer than the seed dateUpdated (2026-04-13),
  // so the progression gate (record.date > max.dateUpdated) passes for hits.
  // Both Squat (200+5=205 < 315) and Deadlift (300+10=310 < 405) would be reductions
  // → both flagged, not applied.
  // -------------------------------------------------------------------------

  describe('multi-workout progression scenario', () => {
    it('logs bodyweight at session start', async () => {
      const res = await postJson(`/programs/${SEED_PROGRAM}/body-weight`, {
        date: '2026-07-01',
        weight: 190,
        unit: 'lbs',
      });
      expect(res.statusCode).toBe(201);
    });

    it('logs workout 1 — Squat hits target, Bench Press misses', async () => {
      // Squat set 1: reps=5 >= spec.reps=5 → progression gate passes
      const squatRes = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 3,
        workoutNum: 1,
        date: '2026-07-01',
        lift: 'Squat',
        setNum: 1,
        weight: 200,
        reps: 5,
        notes: '',
      });
      expect(squatRes.statusCode).toBe(201);

      // Bench Press set 1: reps=3 < spec.reps=5 → progression gate fails
      const benchRes = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 3,
        workoutNum: 1,
        date: '2026-07-01',
        lift: 'Bench Press',
        setNum: 1,
        weight: 160,
        reps: 3,
        notes: '',
      });
      expect(benchRes.statusCode).toBe(201);
    });

    it('logs workout 2 — Deadlift hits target, Overhead Press misses', async () => {
      // Deadlift set 1: reps=5 >= spec.reps=5 → progression gate passes
      const dlRes = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 3,
        workoutNum: 2,
        date: '2026-07-08',
        lift: 'Deadlift',
        setNum: 1,
        weight: 300,
        reps: 5,
        notes: '',
      });
      expect(dlRes.statusCode).toBe(201);

      // Overhead Press set 1: reps=2 < spec.reps=5 → progression gate fails
      const ohpRes = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 3,
        workoutNum: 2,
        date: '2026-07-08',
        lift: 'Overhead Press',
        setNum: 1,
        weight: 100,
        reps: 2,
        notes: '',
      });
      expect(ohpRes.statusCode).toBe(201);
    });

    it('GET /workouts/1 reflects completion status after workout 1 is logged', async () => {
      const res = await get(`/programs/${SEED_PROGRAM}/workouts/1`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cycleNum).toBe(3);
      expect(body.workoutNum).toBe(1);
      const liftNames = body.lifts.map((l: { lift: string }) => l.lift);
      expect(liftNames).toContain('Squat');
      expect(liftNames).toContain('Bench Press');
    });

    it('GET /workouts/2 reflects completion status after workout 2 is logged', async () => {
      const res = await get(`/programs/${SEED_PROGRAM}/workouts/2`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cycleNum).toBe(3);
      expect(body.workoutNum).toBe(2);
      const liftNames = body.lifts.map((l: { lift: string }) => l.lift);
      expect(liftNames).toContain('Deadlift');
      expect(liftNames).toContain('Overhead Press');
    });

    it('GET /cycles/current lists each logged workoutNum once, sorted (issue #982)', async () => {
      // Workout 1 holds two records (Squat + Bench Press) and workout 2 two more,
      // so the set must dedupe as well as scope to the current cycle.
      const res = await get(`/programs/${SEED_PROGRAM}/cycles/current`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { completedWorkoutNums: number[] }).completedWorkoutNums).toEqual([1, 2]);
    });

    it('POST /training-maxes/recalculate flags reductions; only genuine increases are applied', async () => {
      const res = await post(`/programs/${SEED_PROGRAM}/training-maxes/recalculate`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { maxes: Array<{ lift: string; weight: number }>; flagged: Array<{ lift: string; proposedWeight: number }> };
      const findMax = (lift: string) => body.maxes.find((m) => m.lift === lift)!;
      const findFlag = (lift: string) => body.flagged.find((f) => f.lift === lift);

      // Squat hit target (200 × 5) but 200+5=205 < current TM 315 → flagged, max unchanged
      expect(findMax('Squat').weight).toBe(315);
      expect(findFlag('Squat')).toBeDefined();
      expect(findFlag('Squat')!.proposedWeight).toBe(205);

      // Bench Press missed (3 reps < 5): no update, not flagged
      expect(findMax('Bench Press').weight).toBe(225);
      expect(findFlag('Bench Press')).toBeUndefined();

      // Deadlift hit target (300 × 5) but 300+10=310 < current TM 405 → flagged, max unchanged
      expect(findMax('Deadlift').weight).toBe(405);
      expect(findFlag('Deadlift')).toBeDefined();
      expect(findFlag('Deadlift')!.proposedWeight).toBe(310);

      // Overhead Press missed (2 reps < 5): no update, not flagged
      expect(findMax('Overhead Press').weight).toBe(145);
      expect(findFlag('Overhead Press')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Multi-cycle progression scenario — issue #142.
  //
  // Order-sensitive, continues from the state left by the multi-workout
  // scenario above:
  //   cycleNum:   3
  //   TMs:        Squat 315, Bench 225, Deadlift 405, Overhead Press 145
  //               (all dateUpdated 2026-04-13 — none updated by prior recalc)
  //   records:    cycle-3 set-1 entries for all 4 lifts (none updated TMs)
  //
  // Goal: drive at least one lift through a genuine TM increase across two
  // cycle-advance boundaries and assert the updated maxes persist into the
  // next cycle (the carry-forward chain that makes new-cycle planned
  // weights derive from prior-cycle outcomes).
  //
  // Logged set-1 weights are engineered at-or-near current TMs (not realistic
  // 5/3/1 loading) so the progression branch fires deterministically:
  //   record.reps >= spec.reps AND record.weight + spec.increment > current TM.
  // -------------------------------------------------------------------------

  describe('multi-cycle progression scenario (issue #142)', () => {
    // Tests in this block are order-dependent — do not reorder. Each `it`
    // mutates adapter state (cycleNum, training maxes, dateUpdated) that the
    // next one reads. Reordering will silently break expected-weight assertions
    // because the TM/dateUpdated gates in updateMaxes depend on prior state.
    it('advances cycle 3 → 4 to clear prior-scenario state; TMs unchanged', async () => {
      // Existing cycle-3 records were all flagged → updateMaxes leaves TMs at
      // 315/225/405/145. Advancing now just bumps cycleNum.
      const advanceRes = await post(`/programs/${SEED_PROGRAM}/cycles`);
      expect(advanceRes.statusCode).toBe(201);
      expect(advanceRes.json().cycleNum).toBe(4);

      const tmRes = await get(`/programs/${SEED_PROGRAM}/training-maxes`);
      expect(tmRes.statusCode).toBe(200);
      const findTm = (lift: string) =>
        tmRes.json().find((m: { lift: string }) => m.lift === lift)!;
      expect(findTm('Squat').weight).toBe(315);
      expect(findTm('Bench Press').weight).toBe(225);
      expect(findTm('Deadlift').weight).toBe(405);
      expect(findTm('Overhead Press').weight).toBe(145);
    });

    it('cycle 4: logs records that drive Squat + Bench progression, leaves DL + OHP unchanged', async () => {
      // Date 2026-08-03 > all current TMs' dateUpdated (2026-04-13) → gate passes on date.
      // Squat: 315 + 5 = 320 > current TM 315 → applies (TM → 320).
      const squat = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 4, workoutNum: 1, date: '2026-08-03',
        lift: 'Squat', setNum: 1, weight: 315, reps: 5, notes: '',
      });
      expect(squat.statusCode).toBe(201);

      // Bench: 225 + 5 = 230 > current TM 225 → applies (TM → 230).
      const bench = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 4, workoutNum: 1, date: '2026-08-03',
        lift: 'Bench Press', setNum: 1, weight: 225, reps: 5, notes: '',
      });
      expect(bench.statusCode).toBe(201);

      // Deadlift: reps 3 < spec.reps 5 → gate fails (TM unchanged at 405).
      const dl = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 4, workoutNum: 1, date: '2026-08-03',
        lift: 'Deadlift', setNum: 1, weight: 300, reps: 3, notes: '',
      });
      expect(dl.statusCode).toBe(201);

      // OHP: reps 2 < spec.reps 5 → gate fails (TM unchanged at 145).
      const ohp = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 4, workoutNum: 1, date: '2026-08-03',
        lift: 'Overhead Press', setNum: 1, weight: 100, reps: 2, notes: '',
      });
      expect(ohp.statusCode).toBe(201);
    });

    it('cycle 4 → 5: recalculate applies Squat + Bench increases with no flags', async () => {
      const res = await post(`/programs/${SEED_PROGRAM}/training-maxes/recalculate`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        maxes: Array<{ lift: string; weight: number }>;
        flagged: Array<{ lift: string }>;
      };
      const findMax = (lift: string) => body.maxes.find((m) => m.lift === lift)!;

      expect(findMax('Squat').weight).toBe(320);          // 315 + 5
      expect(findMax('Bench Press').weight).toBe(230);    // 225 + 5
      expect(findMax('Deadlift').weight).toBe(405);       // unchanged
      expect(findMax('Overhead Press').weight).toBe(145); // unchanged
      expect(body.flagged).toEqual([]);
    });

    it('cycle 4 → 5: POST /cycles persists updated maxes into cycle 5 (carry-forward)', async () => {
      const advanceRes = await post(`/programs/${SEED_PROGRAM}/cycles`);
      expect(advanceRes.statusCode).toBe(201);
      expect(advanceRes.json().cycleNum).toBe(5);

      // Carry-forward assertion: the maxes that downstream cycle-5 planned
      // weights will be computed from must reflect cycle-4 outcomes.
      const tmRes = await get(`/programs/${SEED_PROGRAM}/training-maxes`);
      expect(tmRes.statusCode).toBe(200);
      const findTm = (lift: string) =>
        tmRes.json().find((m: { lift: string }) => m.lift === lift)!;
      expect(findTm('Squat').weight).toBe(320);
      expect(findTm('Bench Press').weight).toBe(230);
      expect(findTm('Deadlift').weight).toBe(405);
      expect(findTm('Overhead Press').weight).toBe(145);
    });

    it('cycle 5: logs records with different per-lift outcomes than cycle 4', async () => {
      // Date 2026-09-07 > all current TMs' dateUpdated (Squat/Bench: 2026-08-03;
      // DL/OHP: 2026-04-13) → gate passes on date for every lift.

      // Squat: reps 3 < 5 → gate fails (TM unchanged at 320).
      const squat = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 5, workoutNum: 1, date: '2026-09-07',
        lift: 'Squat', setNum: 1, weight: 322, reps: 3, notes: '',
      });
      expect(squat.statusCode).toBe(201);

      // Bench: 232 + 5 = 237 > current TM 230 → applies (TM → 237).
      const bench = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 5, workoutNum: 1, date: '2026-09-07',
        lift: 'Bench Press', setNum: 1, weight: 232, reps: 5, notes: '',
      });
      expect(bench.statusCode).toBe(201);

      // Deadlift: 410 + 10 = 420 > current TM 405 → applies (TM → 420).
      const dl = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 5, workoutNum: 1, date: '2026-09-07',
        lift: 'Deadlift', setNum: 1, weight: 410, reps: 5, notes: '',
      });
      expect(dl.statusCode).toBe(201);

      // OHP: 145 + 5 = 150 > current TM 145 → applies (TM → 150).
      const ohp = await postJson(`/programs/${SEED_PROGRAM}/lift-records`, {
        cycleNum: 5, workoutNum: 1, date: '2026-09-07',
        lift: 'Overhead Press', setNum: 1, weight: 145, reps: 5, notes: '',
      });
      expect(ohp.statusCode).toBe(201);
    });

    it('cycle 5 → 6: recalculate composes correctly across the second boundary', async () => {
      const res = await post(`/programs/${SEED_PROGRAM}/training-maxes/recalculate`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        maxes: Array<{ lift: string; weight: number }>;
        flagged: Array<{ lift: string }>;
      };
      const findMax = (lift: string) => body.maxes.find((m) => m.lift === lift)!;

      expect(findMax('Squat').weight).toBe(320);          // unchanged (reps<5)
      expect(findMax('Bench Press').weight).toBe(237);    // 232 + 5
      expect(findMax('Deadlift').weight).toBe(420);       // 410 + 10
      expect(findMax('Overhead Press').weight).toBe(150); // 145 + 5
      expect(body.flagged).toEqual([]);
    });

    it('cycle 5 → 6: POST /cycles persists final composed maxes into cycle 6', async () => {
      const advanceRes = await post(`/programs/${SEED_PROGRAM}/cycles`);
      expect(advanceRes.statusCode).toBe(201);
      expect(advanceRes.json().cycleNum).toBe(6);

      const tmRes = await get(`/programs/${SEED_PROGRAM}/training-maxes`);
      expect(tmRes.statusCode).toBe(200);
      const findTm = (lift: string) =>
        tmRes.json().find((m: { lift: string }) => m.lift === lift)!;
      expect(findTm('Squat').weight).toBe(320);
      expect(findTm('Bench Press').weight).toBe(237);
      expect(findTm('Deadlift').weight).toBe(420);
      expect(findTm('Overhead Press').weight).toBe(150);
    });
  });

  // -------------------------------------------------------------------------
  // Training max history — order-sensitive, continues from multi-cycle scenario.
  // At this point cycle advances and recalculates have written history entries.
  // -------------------------------------------------------------------------

  describe('training max history', () => {
    it('GET /training-maxes/history returns entries after cycle advances', async () => {
      const res = await get(`/programs/${SEED_PROGRAM}/training-maxes/history`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.entries.length).toBeGreaterThan(0);
      for (const e of body.entries) {
        expect(e).toMatchObject({
          id: expect.any(String),
          lift: expect.any(String),
          weight: expect.any(Number),
          unit: 'lbs',
          date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          isPR: expect.any(Boolean),
          source: expect.stringMatching(/^(test|program)$/),
          goalMet: expect.any(Boolean),
        });
      }
    });

    it('GET /training-maxes/history?lift=Bench+Press filters to that lift', async () => {
      const res = await get(
        `/programs/${SEED_PROGRAM}/training-maxes/history?lift=${encodeURIComponent('Bench Press')}`,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries.every((e: { lift: string }) => e.lift === 'Bench Press')).toBe(true);
    });

    it('GET /training-maxes/history?isPR=true returns empty before any entry is marked', async () => {
      const res = await get(`/programs/${SEED_PROGRAM}/training-maxes/history?isPR=true`);
      expect(res.statusCode).toBe(200);
      expect(res.json().entries).toEqual([]);
    });

    it('PATCH /training-maxes/history/:id marks an entry as PR', async () => {
      const listRes = await get(`/programs/${SEED_PROGRAM}/training-maxes/history`);
      const firstId = listRes.json().entries[0].id as string;

      const patchRes = await app.getHttpAdapter().getInstance().inject({
        method: 'PATCH',
        url: `/programs/${SEED_PROGRAM}/training-maxes/history/${firstId}`,
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
        payload: JSON.stringify({ isPR: true }),
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({ id: firstId, isPR: true });

      // Verify persistence: GET ?isPR=true now includes the entry
      const prRes = await get(`/programs/${SEED_PROGRAM}/training-maxes/history?isPR=true`);
      expect(prRes.json().entries.some((e: { id: string }) => e.id === firstId)).toBe(true);
    });

    it('PATCH /training-maxes/history/:id with unknown id returns 404', async () => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'PATCH',
        url: `/programs/${SEED_PROGRAM}/training-maxes/history/nonexistent-id`,
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
        payload: JSON.stringify({ isPR: true }),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('isolates adapter state between users', async () => {
    const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
      app.getHttpAdapter().getInstance(),
    );

    const AS_ALICE = { authorization: 'Bearer user-alice' };
    const AS_BOB   = { authorization: 'Bearer user-bob'  };

    // Alice writes a distinctive training max — her bundle starts empty, this creates it.
    const patchRes = await injectRaw({
      method: 'PATCH',
      url: `/programs/${SEED_PROGRAM}/training-maxes`,
      headers: { 'content-type': 'application/json', ...AS_ALICE },
      payload: JSON.stringify({ maxes: [{ lift: 'Squat', weight: 999, unit: 'lbs' }] }),
    });
    expect(patchRes.statusCode).toBe(200);

    // Alice sees her value.
    const aliceRes = await injectRaw({
      method: 'GET',
      url: `/programs/${SEED_PROGRAM}/training-maxes`,
      headers: AS_ALICE,
    });
    expect(aliceRes.json().find((m: { lift: string }) => m.lift === 'Squat')?.weight).toBe(999);

    // Bob reads the same program — his bundle is independent; Alice's write must not appear.
    const bobRes = await injectRaw({
      method: 'GET',
      url: `/programs/${SEED_PROGRAM}/training-maxes`,
      headers: AS_BOB,
    });
    expect(bobRes.statusCode).toBe(200);
    const bobSquat = bobRes.json().find((m: { lift: string }) => m.lift === 'Squat');
    expect(bobSquat).toBeUndefined();
  });

  describe('strength-goals write operations', () => {
    const GOAL_URL = `/programs/${SEED_PROGRAM}/strength-goals`;

    it('PUT → GET → DELETE lifecycle (relative goal)', async () => {
      // PUT creates a relative goal
      const putRes = await putJson(`${GOAL_URL}/Squat`, { goalType: 'relative', ratio: 1.75, unit: 'lbs' });
      expect(putRes.statusCode).toBe(200);
      const created = putRes.json();
      expect(created.lift).toBe('Squat');
      expect(created.goalType).toBe('relative');
      expect(created.ratio).toBe(1.75);
      expect(created.unit).toBe('lbs');

      // GET returns the goal
      const getRes = await get(GOAL_URL);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ lift: 'Squat', goalType: 'relative', ratio: 1.75 }),
      ]));

      // DELETE removes the goal
      const delRes = await deleteReq(`${GOAL_URL}/Squat`);
      expect(delRes.statusCode).toBe(204);

      // GET after DELETE returns empty
      const getAfterDel = await get(GOAL_URL);
      const remaining = getAfterDel.json() as { lift: string }[];
      expect(remaining.find((g) => g.lift === 'Squat')).toBeUndefined();
    });

    it('PUT absolute goal stores target', async () => {
      const putRes = await putJson(`${GOAL_URL}/Bench Press`, { goalType: 'absolute', target: 225, unit: 'lbs' });
      expect(putRes.statusCode).toBe(200);
      const created = putRes.json();
      expect(created.goalType).toBe('absolute');
      expect(created.target).toBe(225);
    });

    it('PUT same lift twice — only latest persists (idempotency)', async () => {
      await putJson(`${GOAL_URL}/Deadlift`, { goalType: 'absolute', target: 400, unit: 'lbs' });
      const secondPut = await putJson(`${GOAL_URL}/Deadlift`, { goalType: 'absolute', target: 450, unit: 'lbs' });
      expect(secondPut.statusCode).toBe(200);
      expect(secondPut.json().target).toBe(450);

      const getRes = await get(GOAL_URL);
      const goals = getRes.json() as { lift: string; target: number }[];
      const deadlifts = goals.filter((g) => g.lift === 'Deadlift');
      expect(deadlifts).toHaveLength(1);
      expect(deadlifts[0].target).toBe(450);
    });

    it('DELETE unknown lift returns 404', async () => {
      const res = await deleteReq(`${GOAL_URL}/UnknownLift`);
      expect(res.statusCode).toBe(404);
    });

    it('isolates strength goals between users', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
        app.getHttpAdapter().getInstance(),
      );

      const AS_ALICE = { authorization: 'Bearer user-alice-goals' };
      const AS_BOB   = { authorization: 'Bearer user-bob-goals' };

      // Alice writes a strength goal
      const alicePut = await injectRaw({
        method: 'PUT',
        url: `${GOAL_URL}/Bench Press`,
        headers: { 'content-type': 'application/json', ...AS_ALICE },
        payload: JSON.stringify({ goalType: 'absolute', target: 200, unit: 'lbs' }),
      });
      expect(alicePut.statusCode).toBe(200);

      // Bob reads — must not see Alice's goal
      const bobGet = await injectRaw({
        method: 'GET',
        url: GOAL_URL,
        headers: AS_BOB,
      });
      expect(bobGet.statusCode).toBe(200);
      const bobGoals = bobGet.json() as { lift: string }[];
      expect(bobGoals.find((g) => g.lift === 'Bench Press')).toBeUndefined();
    });
  });

  describe('manage lifts overrides', () => {
    const PROGRAM = SEED_PROGRAM;
    // Cycle 1, workout 1 is used for override tests. The seed data has records
    // for the dev user so override operations run against a known baseline.
    const OVERRIDE_URL = (cycleNum: number, workoutNum: number) =>
      `/programs/${PROGRAM}/cycles/${cycleNum}/workouts/${workoutNum}/lift-overrides`;

    it('GET /programs/:program/lifts returns the lift catalog', async () => {
      const res = await get(`/programs/${PROGRAM}/lifts`);
      expect(res.statusCode).toBe(200);
      const lifts = res.json() as string[];
      expect(Array.isArray(lifts)).toBe(true);
      expect(lifts).toContain('Squat');
      expect(lifts.length).toBeGreaterThan(0);
    });

    it('POST add override returns 201 with the override', async () => {
      const res = await postJson(OVERRIDE_URL(1, 1), { action: 'add', lift: 'Chin-up' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ action: 'add', lift: 'Chin-up' });
    });

    it('POST remove override and GET workout — lift absent from response', async () => {
      // First confirm Squat is present in workout 1
      const before = await get(`/programs/${PROGRAM}/workouts/1`);
      expect(before.statusCode).toBe(200);
      const liftsBefore = (before.json() as { lifts: { lift: string }[] }).lifts;
      expect(liftsBefore.some((l) => l.lift === 'Squat')).toBe(true);

      // Apply remove override using the current cycleNum from dashboard
      const dashRes = await get(`/programs/${PROGRAM}/cycles/current`);
      const { cycleNum } = dashRes.json() as { cycleNum: number };
      await postJson(OVERRIDE_URL(cycleNum, 1), { action: 'remove', lift: 'Squat' });

      // GET workout — Squat should now be absent
      const after = await get(`/programs/${PROGRAM}/workouts/1`);
      expect(after.statusCode).toBe(200);
      const liftsAfter = (after.json() as { lifts: { lift: string }[] }).lifts;
      expect(liftsAfter.some((l) => l.lift === 'Squat')).toBe(false);

      // Cleanup: delete the override
      const dashRes2 = await get(`/programs/${PROGRAM}/cycles/current`);
      const { cycleNum: cn } = dashRes2.json() as { cycleNum: number };
      await deleteReq(`${OVERRIDE_URL(cn, 1)}/Squat`);
    });

    it('POST replace override — old lift absent, new lift present', async () => {
      const dashRes = await get(`/programs/${PROGRAM}/cycles/current`);
      const { cycleNum } = dashRes.json() as { cycleNum: number };
      await postJson(OVERRIDE_URL(cycleNum, 1), { action: 'replace', lift: 'Squat', replacedBy: 'Front Squat' });

      const res = await get(`/programs/${PROGRAM}/workouts/1`);
      const lifts = (res.json() as { lifts: { lift: string }[] }).lifts;
      expect(lifts.some((l) => l.lift === 'Squat')).toBe(false);
      expect(lifts.some((l) => l.lift === 'Front Squat')).toBe(true);

      // Cleanup
      await deleteReq(`${OVERRIDE_URL(cycleNum, 1)}/Squat`);
    });

    it('DELETE override is idempotent — returns 204 even when override absent', async () => {
      const dashRes = await get(`/programs/${PROGRAM}/cycles/current`);
      const { cycleNum } = dashRes.json() as { cycleNum: number };
      const res = await deleteReq(`${OVERRIDE_URL(cycleNum, 99)}/NonExistentLift`);
      expect(res.statusCode).toBe(204);
    });

    it('POST replace without replacedBy returns 400', async () => {
      const res = await postJson(OVERRIDE_URL(1, 1), { action: 'replace', lift: 'Squat' });
      expect(res.statusCode).toBe(400);
    });

    it('isolates lift overrides between users', async () => {
      const injectRaw = app.getHttpAdapter().getInstance().inject.bind(
        app.getHttpAdapter().getInstance(),
      );
      // Alice is the pre-seeded dev user (has a cycle dashboard); Bob is a fresh user.
      const AS_ALICE = AUTH;
      const AS_BOB   = { authorization: 'Bearer user-bob-lifts' };

      // Alice adds a Cable Curls override for the current cycle, workout 1.
      const dashRes = await injectRaw({ method: 'GET', url: `/programs/${PROGRAM}/cycles/current`, headers: AS_ALICE });
      const { cycleNum } = dashRes.json() as { cycleNum: number };
      await injectRaw({
        method: 'POST',
        url: OVERRIDE_URL(cycleNum, 1),
        headers: { 'content-type': 'application/json', ...AS_ALICE },
        payload: JSON.stringify({ action: 'add', lift: 'Cable Curls' }),
      });

      // Bob GETs workout 1 — should NOT see Cable Curls (Alice's override is isolated).
      const bobWorkout = await injectRaw({ method: 'GET', url: `/programs/${PROGRAM}/workouts/1`, headers: AS_BOB });
      expect(bobWorkout.statusCode).toBe(200);
      const bobLifts = (bobWorkout.json() as { lifts: { lift: string }[] }).lifts;
      expect(bobLifts.some((l) => l.lift === 'Cable Curls')).toBe(false);
    });
  });

  describe('lift metadata', () => {
    const AS_BOB = { authorization: 'Bearer user-b-token' };

    it('GET /lifts/:lift/metadata requires auth', async () => {
      const res = await app
        .getHttpAdapter()
        .getInstance()
        .inject({ method: 'GET', url: '/lifts/Squat/metadata' });
      expect(res.statusCode).toBe(401);
    });

    it('GET /lifts/:lift/metadata returns defaults when no record exists', async () => {
      const res = await get('/lifts/Squat/metadata');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { lift: string; muscleGroups: string[]; substitutions: string[]; foundational: boolean };
      expect(body.lift).toBe('Squat');
      expect(body.muscleGroups).toEqual([]);
      expect(body.substitutions).toEqual([]);
      expect(body.foundational).toBe(false);
    });

    it('PATCH /lifts/:lift/metadata persists values and GET returns them', async () => {
      const patchRes = await patchJson('/lifts/Squat/metadata', {
        muscleGroups: ['Quads', 'Glutes'],
        substitutions: ['Leg Press'],
        foundational: true,
      });
      expect(patchRes.statusCode).toBe(200);
      const patched = patchRes.json() as { muscleGroups: string[]; substitutions: string[]; foundational: boolean };
      expect(patched.muscleGroups).toEqual(['Quads', 'Glutes']);
      expect(patched.substitutions).toEqual(['Leg Press']);
      expect(patched.foundational).toBe(true);

      const getRes = await get('/lifts/Squat/metadata');
      expect(getRes.statusCode).toBe(200);
      const fetched = getRes.json() as typeof patched;
      expect(fetched.muscleGroups).toEqual(['Quads', 'Glutes']);
      expect(fetched.substitutions).toEqual(['Leg Press']);
      expect(fetched.foundational).toBe(true);
    });

    it('PATCH /lifts/:lift/metadata is partial — unpatched fields retain prior values', async () => {
      await patchJson('/lifts/Deadlift/metadata', {
        muscleGroups: ['Hamstrings', 'Glutes'],
        substitutions: ['Romanian Deadlift'],
        foundational: true,
      });
      await patchJson('/lifts/Deadlift/metadata', { substitutions: ['Trap Bar Deadlift'] });
      const res = await get('/lifts/Deadlift/metadata');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { muscleGroups: string[]; substitutions: string[]; foundational: boolean };
      expect(body.muscleGroups).toEqual(['Hamstrings', 'Glutes']);
      expect(body.substitutions).toEqual(['Trap Bar Deadlift']);
      expect(body.foundational).toBe(true);
    });

    it('user isolation: User B gets empty defaults when User A has metadata', async () => {
      const res = await app
        .getHttpAdapter()
        .getInstance()
        .inject({ method: 'GET', url: '/lifts/Squat/metadata', headers: AS_BOB });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { muscleGroups: string[]; substitutions: string[]; foundational: boolean };
      expect(body.muscleGroups).toEqual([]);
      expect(body.substitutions).toEqual([]);
      expect(body.foundational).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Schedule mode: verify distributeWorkouts() integrates with cycle lifecycle
  // Uses a fresh user ID to avoid interfering with the seeded dev-token state.
  // ---------------------------------------------------------------------------

  describe('schedule mode', () => {
    const SCHEDULE_USER_TOKEN = 'schedule-e2e-user';
    const AS_SCHEDULE_USER = { authorization: `Bearer ${SCHEDULE_USER_TOKEN}` };

    const scheduleGet = (url: string) =>
      app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers: AS_SCHEDULE_USER });

    const schedulePost = (url: string, body?: unknown) =>
      app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url,
        headers: body
          ? { 'content-type': 'application/json', ...AS_SCHEDULE_USER }
          : AS_SCHEDULE_USER,
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });

    async function setScheduleForUser(userId: string): Promise<void> {
      const factory = app.get<InMemoryRepositoryFactory>(REPOSITORY_FACTORY);
      const bundle = await factory.forUser({ id: userId, email: '', provider: 'dev' });
      (bundle.userSettings as InMemoryUserSettingsRepository).setSchedule({
        type: 'fixed',
        days: [0, 2, 4], // Mon, Wed, Fri
      });
    }

    it('GET cycle dashboard returns weeks:[] when no schedule is set', async () => {
      await schedulePost(`/programs/${SEED_PROGRAM}/cycles/initialize`, { cycleDate: '2026-05-19' });
      const res = await scheduleGet(`/programs/${SEED_PROGRAM}/cycles/current`);
      expect(res.statusCode).toBe(200);
      expect(res.json().weeks).toEqual([]);
    });

    it('GET cycle dashboard returns populated weeks when schedule is set before cycle init', async () => {
      const userId = 'schedule-e2e-with-schedule';
      const token = `Bearer ${userId}`;
      await setScheduleForUser(userId);

      const initRes = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({ cycleDate: '2026-05-19' }),
      });
      expect(initRes.statusCode).toBe(201);

      const dashRes = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/cycles/current`,
        headers: { authorization: token },
      });
      expect(dashRes.statusCode).toBe(200);
      const body = dashRes.json();
      expect(Array.isArray(body.weeks)).toBe(true);
      expect(body.weeks.length).toBeGreaterThan(0);
      // Mon-Wed-Fri schedule: week 1 should have dates on Mon/Wed/Fri
      const week1 = body.weeks[0];
      expect(week1.week).toBe(1);
      expect(Array.isArray(week1.workouts)).toBe(true);
      expect(week1.workouts.length).toBeGreaterThan(0);
      expect(week1.completed).toBe(false);
      // Each workout entry should have workoutNum and a valid ISO date string
      for (const ws of week1.workouts) {
        expect(typeof ws.workoutNum).toBe('number');
        expect(ws.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('GET workout returns scheduled date as date when no records exist and schedule is active', async () => {
      const userId = 'schedule-e2e-workout-date';
      const token = `Bearer ${userId}`;
      await setScheduleForUser(userId);

      await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({ cycleDate: '2026-05-19' }),
      });

      // Get the scheduled date for workout 1 from the dashboard
      const dashRes = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/cycles/current`,
        headers: { authorization: token },
      });
      const dashBody = dashRes.json();
      const allWorkouts = dashBody.weeks.flatMap((w: { workouts: { workoutNum: number; date: string }[] }) => w.workouts);
      const scheduled = allWorkouts.find((ws: { workoutNum: number }) => ws.workoutNum === 1);
      expect(scheduled).toBeDefined();

      // GET workout 1 — should return the scheduled date as `date`
      const workoutRes = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/workouts/1`,
        headers: { authorization: token },
      });
      expect(workoutRes.statusCode).toBe(200);
      expect(workoutRes.json().date).toBe(scheduled!.date);
    });

    it('POST lift-records without date uses scheduled date', async () => {
      const userId = 'schedule-e2e-lift-record-date';
      const token = `Bearer ${userId}`;
      await setScheduleForUser(userId);

      await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({ cycleDate: '2026-05-19' }),
      });

      // Get the scheduled date for workout 1
      const dashRes = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/cycles/current`,
        headers: { authorization: token },
      });
      const allWorkouts = dashRes.json().weeks.flatMap((w: { workouts: { workoutNum: number; date: string }[] }) => w.workouts);
      const scheduledDate = allWorkouts.find((ws: { workoutNum: number }) => ws.workoutNum === 1)!.date;

      // POST lift record without date
      const recordRes = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/lift-records`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({
          program: SEED_PROGRAM,
          cycleNum: 1,
          workoutNum: 1,
          lift: 'Squat',
          setNum: 1,
          weight: 135,
          reps: 5,
        }),
      });
      expect(recordRes.statusCode).toBe(201);
      expect(recordRes.json().date).toBe(scheduledDate);
    });

    it('GET cycle dashboard returns weeks:[] when no schedule is set (schedule user baseline)', async () => {
      // A fresh user with no schedule should still see weeks:[]
      const userId = 'schedule-e2e-no-schedule';
      const token = `Bearer ${userId}`;

      await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({ cycleDate: '2026-05-19' }),
      });

      const dashRes = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/cycles/current`,
        headers: { authorization: token },
      });
      expect(dashRes.statusCode).toBe(200);
      expect(dashRes.json().weeks).toEqual([]);
    });
  });

  describe('workout skip override', () => {
    async function setupSkipUser(userId: string): Promise<string> {
      const token = `Bearer ${userId}`;
      // Set Mon/Wed/Fri schedule via factory (mirrors setScheduleForUser in schedule mode tests)
      const factory = app.get<InMemoryRepositoryFactory>(REPOSITORY_FACTORY);
      const bundle = await factory.forUser({ id: userId, email: '', provider: 'dev' });
      (bundle.userSettings as InMemoryUserSettingsRepository).setSchedule({ type: 'fixed', days: [0, 2, 4] });
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({ cycleDate: '2026-05-19' }),
      });
      return token;
    }

    it('POST skip marks workout as skipped:true in dashboard', async () => {
      const token = await setupSkipUser('skip-e2e-skip-marks');

      const skipRes = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/1/workouts/1/skip`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({}),
      });
      expect(skipRes.statusCode).toBe(204);

      const dashRes = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/cycles/current`,
        headers: { authorization: token },
      });
      expect(dashRes.statusCode).toBe(200);
      const allWorkouts = dashRes.json().weeks.flatMap((w: { workouts: { workoutNum: number; skipped: boolean }[] }) => w.workouts);
      const w1 = allWorkouts.find((ws: { workoutNum: number }) => ws.workoutNum === 1);
      expect(w1).toBeDefined();
      expect(w1!.skipped).toBe(true);
    });

    it('DELETE skip clears the skip mark (skipped:false)', async () => {
      const token = await setupSkipUser('skip-e2e-unskip');

      await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/1/workouts/1/skip`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({}),
      });

      const unskipRes = await app.getHttpAdapter().getInstance().inject({
        method: 'DELETE',
        url: `/programs/${SEED_PROGRAM}/cycles/1/workouts/1/skip`,
        headers: { authorization: token },
      });
      expect(unskipRes.statusCode).toBe(204);

      const dashRes = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/cycles/current`,
        headers: { authorization: token },
      });
      const allWorkouts = dashRes.json().weeks.flatMap((w: { workouts: { workoutNum: number; skipped: boolean }[] }) => w.workouts);
      const w1 = allWorkouts.find((ws: { workoutNum: number }) => ws.workoutNum === 1);
      expect(w1!.skipped).toBe(false);
    });

    it('week is completed when all workouts are either logged or skipped', async () => {
      const token = await setupSkipUser('skip-e2e-completion');

      // Get week 1 workouts
      const dashRes = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/cycles/current`,
        headers: { authorization: token },
      });
      const week1 = dashRes.json().weeks[0];
      const workoutNums: number[] = week1.workouts.map((ws: { workoutNum: number }) => ws.workoutNum);

      // Log all but the last; skip the last
      for (let i = 0; i < workoutNums.length - 1; i++) {
        await app.getHttpAdapter().getInstance().inject({
          method: 'POST',
          url: `/programs/${SEED_PROGRAM}/lift-records`,
          headers: { 'content-type': 'application/json', authorization: token },
          payload: JSON.stringify({
            program: SEED_PROGRAM,
            cycleNum: 1,
            workoutNum: workoutNums[i],
            lift: 'Squat',
            setNum: 1,
            weight: 135,
            reps: 5,
          }),
        });
      }
      const lastWorkoutNum = workoutNums[workoutNums.length - 1];
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/1/workouts/${lastWorkoutNum}/skip`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({}),
      });

      const finalDash = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `/programs/${SEED_PROGRAM}/cycles/current`,
        headers: { authorization: token },
      });
      expect(finalDash.json().weeks[0].completed).toBe(true);
    });

    // ---- Bounds / cycle / existence validation (#776; mirrors reschedule #775) ----
    // Each uses a fresh setupSkipUser whose active cycle is deterministically 1
    // (it initializes a single cycle), so cycle 2 is reliably non-active. Before
    // #776 the skip controller never loaded the spec or dashboard, so all three
    // of these silently wrote a 204 skip the current-cycle read model can't show.

    it('POST skip with unknown program returns 404', async () => {
      const token = await setupSkipUser('skip-e2e-404-post');
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/no-such-program/cycles/1/workouts/1/skip`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST skip with out-of-range workoutNum returns 400', async () => {
      const token = await setupSkipUser('skip-e2e-oob-post');
      // 9999 is a positive integer (passes the old check) but far past the
      // program's canonical length — a skip there is dead data.
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/1/workouts/9999/skip`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST skip with non-active cycleNum returns 400', async () => {
      const token = await setupSkipUser('skip-e2e-nac-post');
      // The fresh user's active cycle is 1; cycle 2 is not active, so a skip
      // there could never be read.
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/cycles/2/workouts/1/skip`,
        headers: { 'content-type': 'application/json', authorization: token },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE unskip with unknown program returns 404', async () => {
      const token = await setupSkipUser('skip-e2e-404-delete');
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'DELETE',
        url: `/programs/no-such-program/cycles/1/workouts/1/skip`,
        headers: { authorization: token },
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE unskip with out-of-range workoutNum returns 400', async () => {
      const token = await setupSkipUser('skip-e2e-oob-delete');
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'DELETE',
        url: `/programs/${SEED_PROGRAM}/cycles/1/workouts/9999/skip`,
        headers: { authorization: token },
      });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE unskip with non-active cycleNum returns 400', async () => {
      const token = await setupSkipUser('skip-e2e-nac-delete');
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'DELETE',
        url: `/programs/${SEED_PROGRAM}/cycles/2/workouts/1/skip`,
        headers: { authorization: token },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE cycles/current (issue #647) — a program not touched by SEED_PROGRAM's
  // order-sensitive write-operations chain, with fresh per-test user tokens, so
  // this block cannot interfere with (or depend on) state left by earlier blocks.
  // ---------------------------------------------------------------------------

  describe('DELETE /programs/:program/cycles/current', () => {
    const FRESH_PROGRAM = 'leangains';
    const injectRaw = () =>
      app.getHttpAdapter().getInstance().inject.bind(app.getHttpAdapter().getInstance());

    it('DELETE then re-initialize succeeds (full lifecycle)', async () => {
      const AS_FRESH = { authorization: 'Bearer user-cycle-delete-fresh' };
      const inject = injectRaw();

      const initRes = await inject({
        method: 'POST',
        url: `/programs/${FRESH_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', ...AS_FRESH },
        payload: '{}',
      });
      expect(initRes.statusCode).toBe(201);

      const delRes = await inject({
        method: 'DELETE',
        url: `/programs/${FRESH_PROGRAM}/cycles/current`,
        headers: AS_FRESH,
      });
      expect(delRes.statusCode).toBe(204);

      const getRes = await inject({
        method: 'GET',
        url: `/programs/${FRESH_PROGRAM}/cycles/current`,
        headers: AS_FRESH,
      });
      expect(getRes.statusCode).toBe(404);

      // Re-initialize succeeds again — would 409 (ConflictException) if the
      // delete had silently failed to remove the dashboard row.
      const reInitRes = await inject({
        method: 'POST',
        url: `/programs/${FRESH_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', ...AS_FRESH },
        payload: '{}',
      });
      expect(reInitRes.statusCode).toBe(201);
    });

    it('DELETE with no existing cycle returns 404', async () => {
      const AS_NEW = { authorization: 'Bearer user-cycle-delete-none' };
      const res = await injectRaw()({
        method: 'DELETE',
        url: `/programs/${FRESH_PROGRAM}/cycles/current`,
        headers: AS_NEW,
      });
      expect(res.statusCode).toBe(404);
    });

    it('isolates cycle deletion between users', async () => {
      const AS_ALICE = { authorization: 'Bearer user-cycle-delete-alice' };
      const AS_BOB = { authorization: 'Bearer user-cycle-delete-bob' };
      const inject = injectRaw();

      await inject({
        method: 'POST',
        url: `/programs/${FRESH_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', ...AS_ALICE },
        payload: '{}',
      });
      await inject({
        method: 'POST',
        url: `/programs/${FRESH_PROGRAM}/cycles/initialize`,
        headers: { 'content-type': 'application/json', ...AS_BOB },
        payload: '{}',
      });

      const delRes = await inject({
        method: 'DELETE',
        url: `/programs/${FRESH_PROGRAM}/cycles/current`,
        headers: AS_ALICE,
      });
      expect(delRes.statusCode).toBe(204);

      const aliceGet = await inject({
        method: 'GET',
        url: `/programs/${FRESH_PROGRAM}/cycles/current`,
        headers: AS_ALICE,
      });
      expect(aliceGet.statusCode).toBe(404);

      const bobGet = await inject({
        method: 'GET',
        url: `/programs/${FRESH_PROGRAM}/cycles/current`,
        headers: AS_BOB,
      });
      expect(bobGet.statusCode).toBe(200);
      expect(bobGet.json().cycleNum).toBe(1);
    });
  });

  // Regression coverage for the production onboarding escape (#665 / #687).
  // Onboarding's "Start My Program" called POST /programs/:program/switch. The api-client sent
  // `Content-Type: application/json` with an EMPTY body; the real Fastify API rejects that with
  // FST_ERR_CTP_EMPTY_JSON_BODY → 400 (fixed client-side in #667 by sending `{}`). The Playwright
  // mock (apps/web/e2e/mock-api.mjs) had swallowed the empty body to a 200, so the broken request
  // passed every mock-backed test while failing in production. This suite is the always-on
  // (no-Docker) layer; locking the server's 400 here means a future client or mock regression is
  // caught without a database. Fastify rejects the body before the handler runs, so these assert
  // the contract without touching Prisma. The happy path (200 + cycle init) writes user-settings
  // through Prisma and is covered by the DB-backed suite (programs.db.e2e.spec.ts). See #704.
  describe('POST /programs/:program/switch — malformed/empty JSON body (regression for #665)', () => {
    const AS_SWITCH = { authorization: 'Bearer switch-regression-user' };

    it('rejects an empty application/json body with 400 (not a swallowed 200)', async () => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/switch`,
        headers: { 'content-type': 'application/json', ...AS_SWITCH },
        // No payload → an empty body under a JSON content-type: the exact shape #665 sent.
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a malformed JSON body with 400', async () => {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: `/programs/${SEED_PROGRAM}/switch`,
        headers: { 'content-type': 'application/json', ...AS_SWITCH },
        payload: '{not valid json',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST/PATCH /lift-records — request-body validation (issue #893). Both routes
  // declared their @Body() as a plain TypeScript interface, which is erased at
  // compile time — Nest's ValidationPipe had no metatype to validate against and
  // silently let any JSON object reach the handler unchecked. CreateLiftRecordDto /
  // UpdateLiftRecordDto (both in ./create-lift-record.dto / ./update-lift-record.dto)
  // close that gap. Fresh per-test user token against SEED_PROGRAM with an explicit
  // `date` on every write, so — like the DELETE-cycles and switch-regression blocks
  // above — this block cannot interfere with (or depend on) state left by the
  // order-sensitive blocks earlier in this file.
  // ---------------------------------------------------------------------------
  describe('POST/PATCH /lift-records — request-body validation (regression for #893)', () => {
    const AS_VALIDATION = { authorization: 'Bearer lift-record-validation-user' };
    const LIFT_RECORDS_URL = `/programs/${SEED_PROGRAM}/lift-records`;

    const validBody = (overrides: Record<string, unknown> = {}) => ({
      program: SEED_PROGRAM,
      cycleNum: 1,
      workoutNum: 1,
      date: '2026-05-01',
      lift: 'Bench Press',
      setNum: 1,
      weight: 180,
      reps: 5,
      notes: '',
      ...overrides,
    });

    const postValidation = (body: unknown) =>
      app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: LIFT_RECORDS_URL,
        headers: { 'content-type': 'application/json', ...AS_VALIDATION },
        payload: JSON.stringify(body),
      });

    const patchValidation = (id: string, body: unknown) =>
      app.getHttpAdapter().getInstance().inject({
        method: 'PATCH',
        url: `${LIFT_RECORDS_URL}/${id}`,
        headers: { 'content-type': 'application/json', ...AS_VALIDATION },
        payload: JSON.stringify(body),
      });

    it('rejects a non-date-string date with 400 (previously reached the handler unchecked)', async () => {
      const res = await postValidation(validBody({ date: 'not-a-date' }));
      expect(res.statusCode).toBe(400);
    });

    it('rejects a non-numeric weight with 400', async () => {
      const res = await postValidation(validBody({ weight: 'heavy' }));
      expect(res.statusCode).toBe(400);
    });

    it('rejects a non-integer reps with 400', async () => {
      const res = await postValidation(validBody({ reps: 'five' }));
      expect(res.statusCode).toBe(400);
    });

    it('rejects a setNum below 1 with 400', async () => {
      const res = await postValidation(validBody({ setNum: 0 }));
      expect(res.statusCode).toBe(400);
    });

    // Regression for #893's review round 2: an ISO 8601 week-date string passes
    // non-strict (and even strict) isISO8601, but `new Date(...)` can't parse it —
    // without the @Matches decorator this reached the persistence layer as an
    // Invalid Date and 500'd. Proves the fix end-to-end over HTTP, not just at the
    // class-validator level.
    it('rejects an ISO 8601 week-date with 400, not a 500 from Invalid Date downstream', async () => {
      const res = await postValidation(validBody({ date: '2026-W05' }));
      expect(res.statusCode).toBe(400);
    });

    // Regression for #893's review round 2: a shape-valid but nonexistent calendar
    // date (Feb 30) — without the @IsDateString strict option this silently rolled
    // over to a different day rather than being rejected.
    it('rejects a nonexistent calendar date with 400, not a silent day rollover', async () => {
      const res = await postValidation(validBody({ date: '2026-02-30' }));
      expect(res.statusCode).toBe(400);
    });

    // Regression for #893's review round 2: an empty lift would create a record
    // whose id parser rejects the empty lift segment, permanently unreachable by a
    // later PATCH — verified against real Postgres in create-lift-record.dto.spec.ts.
    it('rejects an empty lift with 400', async () => {
      const res = await postValidation(validBody({ lift: '' }));
      expect(res.statusCode).toBe(400);
    });

    // Regression for #893's review round 2: reps is a Postgres Int (32-bit) column —
    // verified this 500s against real Postgres before the @Max ceiling was added.
    it('rejects reps above the int32-safe ceiling with 400', async () => {
      const res = await postValidation(validBody({ reps: 3_000_000_000 }));
      expect(res.statusCode).toBe(400);
    });

    // Regression for #893's review round 2: this harness's ValidationPipe previously
    // omitted forbidNonWhitelisted, so it could not prove this behavior over HTTP —
    // only the DTO-level unit specs (calling class-validator's validate() directly)
    // exercised it. Now that the harness is sourced from the same shared
    // VALIDATION_PIPE_OPTIONS constant as main.ts, this closes that wiring gap.
    it('rejects an unrecognized extra field with 400 (forbidNonWhitelisted, matches production)', async () => {
      const res = await postValidation(validBody({ hacked: true }));
      expect(res.statusCode).toBe(400);
    });

    // Regression for #893's review round 3: date was previously accepted with an
    // optional time/offset component; the controller's toUTCMidnight(new
    // Date(body.date)) reads UTC components, so an offset-bearing value silently
    // shifted to a different calendar day. date is now bare YYYY-MM-DD only.
    it('rejects a date-time with 400 (bare YYYY-MM-DD only, avoids a timezone-dependent day-shift)', async () => {
      const res = await postValidation(validBody({ date: '2026-05-01T10:30:00Z' }));
      expect(res.statusCode).toBe(400);
    });

    // Regression for #893's review round 3: body.program is unused by the write
    // itself (the route :program param is authoritative) but is now a declared,
    // validated part of the accepted contract — silently discarding a *conflicting*
    // value would let a client bug write real data into the wrong program with a
    // 201 giving no indication anything was wrong.
    it('rejects a body.program that conflicts with the route :program param, with 400', async () => {
      const res = await postValidation(validBody({ program: 'some-other-program' }));
      expect(res.statusCode).toBe(400);
    });

    it('accepts a well-formed body with 201 (valid-input pass-through)', async () => {
      const res = await postValidation(validBody({ setNum: 2 }));
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.lift).toBe('Bench Press');
      expect(body.weight).toBe(180);
    });

    it('PATCH rejects a negative weight with 400', async () => {
      const created = await postValidation(validBody({ setNum: 3 }));
      expect(created.statusCode).toBe(201);

      const res = await patchValidation(created.json().id, { weight: -10 });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH accepts a well-formed partial update with 200 (valid-input pass-through)', async () => {
      const created = await postValidation(validBody({ setNum: 4 }));
      expect(created.statusCode).toBe(201);

      const res = await patchValidation(created.json().id, { reps: 6 });
      expect(res.statusCode).toBe(200);
      expect(res.json().reps).toBe(6);
    });

    // Regression for #893's review round 3: an untrimmed lift is a different
    // natural key than its trimmed form, silently fragmenting one lift's history.
    it('accepts a whitespace-padded lift, trimmed before persisting (valid-input pass-through)', async () => {
      const res = await postValidation(validBody({ setNum: 5, lift: '  Bench Press  ' }));
      expect(res.statusCode).toBe(201);
      expect(res.json().lift).toBe('Bench Press');
    });

    // Regression for #893's review round 3: @IsOptional() (now @ValidateIf) skips
    // null, not just undefined — an explicit null weight/reps/notes previously
    // reached the Prisma update as a literal null against a non-nullable column and
    // 500'd (verified against real Postgres; this in-memory suite alone couldn't
    // reproduce it, which is exactly why the DB-backed suite matters here too).
    it('PATCH rejects an explicit null weight with 400', async () => {
      const created = await postValidation(validBody({ setNum: 6 }));
      expect(created.statusCode).toBe(201);

      const res = await patchValidation(created.json().id, { weight: null });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /body-weight and PATCH /training-maxes — request-body validation (issue
  // #897). Both routes declared their @Body() as a plain TypeScript interface,
  // which is erased at compile time — Nest's ValidationPipe had no metatype to
  // validate against and silently let any JSON object reach the handler unchecked.
  // RecordBodyWeightDto / UpdateTrainingMaxesDto (./record-body-weight.dto /
  // ./update-training-maxes.dto) close that gap — the same one #893 closed for
  // POST/PATCH /lift-records.
  //
  // Isolation note (#897 review, resolved by #904): the fresh per-test bearer
  // token isolates both halves — BodyWeightController now resolves a per-user
  // repository via `factory.forUser(user)`, exactly like TrainingMaxesController
  // and every other controller in this file (it used to inject
  // BODY_WEIGHT_REPOSITORY directly, a single app-scoped
  // InMemoryBodyWeightRepository keyed on `program` alone with no per-user
  // dimension — see issue #904 for the production consequence that was). The
  // body-weight sub-block below still uses its own dedicated program path
  // instead of SEED_PROGRAM, to avoid colliding with the earlier
  // 'multi-workout progression scenario' block, which already POSTs a
  // body-weight entry for SEED_PROGRAM.
  // ---------------------------------------------------------------------------
  describe('POST /body-weight and PATCH /training-maxes — request-body validation (regression for #897)', () => {
    const AS_VALIDATION_897 = { authorization: 'Bearer body-weight-training-max-validation-user' };
    // Deliberately NOT SEED_PROGRAM — see the isolation note above.
    const BODY_WEIGHT_PROGRAM = 'bw-validation-897';
    const BODY_WEIGHT_URL = `/programs/${BODY_WEIGHT_PROGRAM}/body-weight`;
    const TRAINING_MAXES_URL = `/programs/${SEED_PROGRAM}/training-maxes`;

    const postBodyWeight = (body: unknown) =>
      app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: BODY_WEIGHT_URL,
        headers: { 'content-type': 'application/json', ...AS_VALIDATION_897 },
        payload: JSON.stringify(body),
      });

    const getLatestBodyWeight = () =>
      app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: `${BODY_WEIGHT_URL}/latest`,
        headers: AS_VALIDATION_897,
      });

    const patchTrainingMaxes = (body: unknown) =>
      app.getHttpAdapter().getInstance().inject({
        method: 'PATCH',
        url: TRAINING_MAXES_URL,
        headers: { 'content-type': 'application/json', ...AS_VALIDATION_897 },
        payload: JSON.stringify(body),
      });

    describe('POST /body-weight', () => {
      const validBody = (overrides: Record<string, unknown> = {}) => ({
        date: '2026-05-01',
        weight: 185,
        unit: 'lbs',
        ...overrides,
      });

      it('rejects a non-date-string date with 400 (previously reached new Date() unchecked)', async () => {
        const res = await postBodyWeight(validBody({ date: 'not-a-date' }));
        expect(res.statusCode).toBe(400);
      });

      // Same class of bug #893's review round 3 fixed for CreateLiftRecordDto.date:
      // the controller's new Date(body.date) parses a date-time differently than a
      // bare date (UTC vs. server-local depending on offset presence), which can
      // silently shift the stored calendar day.
      it('rejects a date-time with 400 (bare YYYY-MM-DD only, avoids a timezone-dependent day-shift)', async () => {
        const res = await postBodyWeight(validBody({ date: '2026-05-01T10:30:00Z' }));
        expect(res.statusCode).toBe(400);
      });

      it('rejects a nonexistent calendar date with 400, not a silent day rollover', async () => {
        const res = await postBodyWeight(validBody({ date: '2026-02-30' }));
        expect(res.statusCode).toBe(400);
      });

      it('rejects a non-numeric weight with 400', async () => {
        const res = await postBodyWeight(validBody({ weight: 'heavy' }));
        expect(res.statusCode).toBe(400);
      });

      it('rejects a negative weight with 400', async () => {
        const res = await postBodyWeight(validBody({ weight: -5 }));
        expect(res.statusCode).toBe(400);
      });

      // Regression for #897 review: matches the client's own validation
      // (WorkoutLogger.tsx's handleBodyWeightSubmit rejects weight <= 0 before
      // ever calling this endpoint) — a body-weight observation of 0 is not
      // meaningful.
      it('rejects a zero weight with 400', async () => {
        const res = await postBodyWeight(validBody({ weight: 0 }));
        expect(res.statusCode).toBe(400);
      });

      it('rejects an unrecognized unit with 400', async () => {
        const res = await postBodyWeight(validBody({ unit: 'stone' }));
        expect(res.statusCode).toBe(400);
      });

      it('rejects an unrecognized extra field with 400 (forbidNonWhitelisted, matches production)', async () => {
        const res = await postBodyWeight(validBody({ hacked: true }));
        expect(res.statusCode).toBe(400);
      });

      it('accepts a well-formed body with 201, persisted and reflected by GET /latest (valid-input pass-through)', async () => {
        const res = await postBodyWeight(validBody());
        expect(res.statusCode).toBe(201);

        const latest = await getLatestBodyWeight();
        expect(latest.statusCode).toBe(200);
        expect(latest.json()).toMatchObject({ date: '2026-05-01', weight: 185, unit: 'lbs' });
      });
    });

    describe('PATCH /training-maxes', () => {
      const validBody = (overrides: Record<string, unknown> = {}) => ({
        maxes: [{ lift: 'Squat', weight: 315, unit: 'lbs' }],
        ...overrides,
      });

      it('rejects a missing maxes field with 400 (previously reached body.maxes.map(...) unguarded and 500)', async () => {
        const res = await patchTrainingMaxes({});
        expect(res.statusCode).toBe(400);
      });

      it('rejects a non-array maxes with 400', async () => {
        const res = await patchTrainingMaxes({ maxes: 'not-an-array' });
        expect(res.statusCode).toBe(400);
      });

      it('rejects an entry missing lift with 400', async () => {
        const res = await patchTrainingMaxes({ maxes: [{ weight: 315, unit: 'lbs' }] });
        expect(res.statusCode).toBe(400);
      });

      it('rejects an entry with an empty lift with 400', async () => {
        const res = await patchTrainingMaxes(validBody({ maxes: [{ lift: '', weight: 315, unit: 'lbs' }] }));
        expect(res.statusCode).toBe(400);
      });

      it('rejects an entry with a non-numeric weight with 400', async () => {
        const res = await patchTrainingMaxes(
          validBody({ maxes: [{ lift: 'Squat', weight: 'heavy', unit: 'lbs' }] }),
        );
        expect(res.statusCode).toBe(400);
      });

      it('rejects an entry with a negative weight with 400', async () => {
        const res = await patchTrainingMaxes(validBody({ maxes: [{ lift: 'Squat', weight: -5, unit: 'lbs' }] }));
        expect(res.statusCode).toBe(400);
      });

      // Regression for #897 review: matches the client's own validation
      // (TrainingMaxesForm.tsx rejects `n <= 0` with "Enter a positive number") —
      // a training max of 0 is not meaningful.
      it('rejects an entry with a zero weight with 400', async () => {
        const res = await patchTrainingMaxes(validBody({ maxes: [{ lift: 'Squat', weight: 0, unit: 'lbs' }] }));
        expect(res.statusCode).toBe(400);
      });

      it('rejects an entry with an unrecognized unit with 400', async () => {
        const res = await patchTrainingMaxes(
          validBody({ maxes: [{ lift: 'Squat', weight: 315, unit: 'stone' }] }),
        );
        expect(res.statusCode).toBe(400);
      });

      // Regression for #897 review: `unit` is validated but never read by
      // TrainingMaxesController (TrainingMax has no unit field; the response
      // mapper always reports 'lbs'), so accepting 'kg' would silently mislabel
      // — not convert — a 140 kg max as 140 lbs. See TrainingMaxEntryDto.unit's
      // doc comment.
      it('rejects an entry with a kg unit with 400 (validated-but-unhonored, would silently mislabel)', async () => {
        const res = await patchTrainingMaxes(
          validBody({ maxes: [{ lift: 'Squat', weight: 140, unit: 'kg' }] }),
        );
        expect(res.statusCode).toBe(400);
      });

      // Regression for #897 review: each entry becomes one Prisma upsert inside
      // a single batched transaction (PrismaTrainingMaxRepository.saveTrainingMaxes),
      // so an unbounded array is an unbounded statement count in one transaction.
      it('rejects a maxes array above the size ceiling with 400', async () => {
        const maxes = Array.from({ length: 101 }, (_, i) => ({
          lift: `Custom Lift ${i}`,
          weight: 100,
          unit: 'lbs',
        }));
        const res = await patchTrainingMaxes({ maxes });
        expect(res.statusCode).toBe(400);
      });

      it('rejects an unrecognized top-level extra field with 400 (forbidNonWhitelisted, matches production)', async () => {
        const res = await patchTrainingMaxes(validBody({ hacked: true }));
        expect(res.statusCode).toBe(400);
      });

      it('rejects an unrecognized field within an entry with 400', async () => {
        const res = await patchTrainingMaxes({
          maxes: [{ lift: 'Squat', weight: 315, unit: 'lbs', hacked: true }],
        });
        expect(res.statusCode).toBe(400);
      });

      // Regression precedent: CreateLiftRecordDto.lift's #893 review round 3 trim
      // (a different endpoint, identical natural-key-fragmentation failure mode —
      // see TrainingMaxEntryDto.lift's doc comment). Proves the fix end-to-end over
      // HTTP: this repo's ValidationPipeOptions (whitelist: true) makes the pipe
      // return the transformed entity even without an explicit `transform: true`.
      it('accepts a well-formed body with 200, trimming a whitespace-padded lift (valid-input pass-through)', async () => {
        const res = await patchTrainingMaxes({ maxes: [{ lift: '  Squat  ', weight: 320, unit: 'lbs' }] });
        expect(res.statusCode).toBe(200);
        const squat = res.json().find((m: { lift: string }) => m.lift === 'Squat');
        expect(squat).toMatchObject({ lift: 'Squat', weight: 320 });
      });
    });
  });
});
