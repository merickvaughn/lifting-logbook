import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { MROUND, defaultFocusPool } from '@lifting-logbook/core';
import {
  DEFAULT_FOCUS_BUDGET,
  EMPTY_FOCUS_DAY_STATE,
  FocusBlockResponse,
  FocusBlockSummaryResponse,
  FocusDayPlanResponse,
  FocusDayState,
  FocusPoolEntry,
} from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';

const PROGRAM = '5-3-1';
const TODAY = '2026-10-25';

function entry(lift: string, overrides: Partial<FocusPoolEntry> = {}): FocusPoolEntry {
  return {
    lift,
    include: 'auto',
    ruleLift: '',
    swapTo: '',
    sets: 3,
    repsLow: 10,
    repsHigh: 12,
    weight: 25,
    trainingMax: 40,
    percent: 65,
    rpe: 8,
    ...overrides,
  };
}

/** A Q4 2026 calves focus block: active on TODAY. */
function blockBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    area: 'Calves',
    period: 'quarterly',
    align: 'calendar',
    start: '2026-10-01',
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    timer: { prep: 10, set: 40, rest: 45 },
    onEnd: 'prompt',
    nextArea: null,
    pool: [entry('Standing Calf Raise', { sets: 4 }), entry('Seated Calf Raise')],
    ...overrides,
  };
}

describe('Focus work HTTP (e2e, in-memory adapters)', () => {
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

  // Each describe block acts as its own user, so the in-memory store starts empty.
  const as = (user: string) => {
    const headers = { authorization: `Bearer ${user}` };
    const inject = (method: string, url: string, body?: unknown) =>
      app.getHttpAdapter().getInstance().inject({
        method: method as 'GET',
        url,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    return {
      inject,
      create: (body: unknown, today = TODAY) => inject('POST', `/focus/blocks?today=${today}`, body),
      list: async (today = TODAY) => {
        const res = await inject('GET', `/focus/blocks?today=${today}`);
        expect(res.statusCode).toBe(200);
        return res.json() as FocusBlockResponse[];
      },
      plan: async (workoutNum = 1, today = TODAY) => {
        const res = await inject('GET', `/programs/${PROGRAM}/workouts/${workoutNum}/focus?today=${today}`);
        expect(res.statusCode).toBe(200);
        return res.json() as FocusDayPlanResponse;
      },
    };
  };

  describe('focus block CRUD', () => {
    const user = as('focus-e2e-crud');

    it('creates a focus block in a series of its own, with its derived status and range', async () => {
      const res = await user.create(blockBody());
      expect(res.statusCode).toBe(201);
      const block = res.json() as FocusBlockResponse;
      expect(block.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(block.series).toBe(block.id);
      expect(block.priority).toBe(1);
      expect(block).toMatchObject({
        area: 'Calves',
        status: 'active',
        rangeStart: '2026-10-01',
        rangeEnd: '2026-12-31',
        pool: [entry('Standing Calf Raise', { sets: 4 }), entry('Seated Calf Raise')],
      });
      expect(block).not.toHaveProperty('userId');
    });

    it('gives a new block the next priority down, and lists highest priority first', async () => {
      const res = await user.create(blockBody({ area: 'Biceps', pool: [entry('Hammer Curl')] }));
      expect((res.json() as FocusBlockResponse).priority).toBe(2);
      const list = await user.list();
      expect(list.map((block) => block.area)).toEqual(['Calves', 'Biceps']);
    });

    it('derives status from the request day: queued before, active within, ended after', async () => {
      expect((await user.list('2026-09-30'))[0]?.status).toBe('queued');
      expect((await user.list('2026-12-31'))[0]?.status).toBe('active');
      expect((await user.list('2027-01-01'))[0]?.status).toBe('ended');
    });

    it('updates any field, including clearing nextArea, and leaves the rest', async () => {
      const [first] = await user.list();
      const res = await user.inject('PATCH', `/focus/blocks/${first?.id}?today=${TODAY}`, {
        selection: 'rotate',
        onEnd: 'autoroll',
        nextArea: 'Core',
        timer: { prep: 5, set: 30, rest: 30 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ selection: 'rotate', onEnd: 'autoroll', nextArea: 'Core', area: 'Calves' });
      const cleared = await user.inject('PATCH', `/focus/blocks/${first?.id}?today=${TODAY}`, {
        onEnd: 'prompt',
        nextArea: null,
      });
      expect(cleared.json()).toMatchObject({ onEnd: 'prompt', nextArea: null });
    });

    it('409s on a second block in the same series starting the same day', async () => {
      const [first] = await user.list();
      const res = await user.create(blockBody({ series: first?.series }));
      expect(res.statusCode).toBe(409);
    });

    it('reorders priorities from a full list of ids, and rejects a partial one', async () => {
      const ids = (await user.list()).map((block) => block.id);
      const reversed = [...ids].reverse();
      const res = await user.inject('PUT', `/focus/blocks/order?today=${TODAY}`, { ids: reversed });
      expect(res.statusCode).toBe(200);
      const list = res.json() as FocusBlockResponse[];
      expect(list.map((block) => block.id)).toEqual(reversed);
      expect(list.map((block) => block.priority)).toEqual([1, 2]);

      const partial = await user.inject('PUT', `/focus/blocks/order?today=${TODAY}`, { ids: [ids[0]] });
      expect(partial.statusCode).toBe(400);
      const repeated = await user.inject('PUT', `/focus/blocks/order?today=${TODAY}`, { ids: [ids[0], ids[0]] });
      expect(repeated.statusCode).toBe(400);
    });

    it('deletes a block, and 404s on one that does not exist', async () => {
      const [first] = await user.list();
      expect((await user.inject('DELETE', `/focus/blocks/${first?.id}`)).statusCode).toBe(204);
      expect((await user.list()).some((block) => block.id === first?.id)).toBe(false);
      expect((await user.inject('DELETE', `/focus/blocks/${first?.id}`)).statusCode).toBe(404);
      expect((await user.inject('PATCH', `/focus/blocks/${first?.id}?today=${TODAY}`, { area: 'Core' })).statusCode).toBe(
        404,
      );
    });

    it("never shows or changes another user's blocks", async () => {
      const [mine] = await user.list();
      const other = as('focus-e2e-crud-other');
      expect(await other.list()).toEqual([]);
      expect((await other.inject('PATCH', `/focus/blocks/${mine?.id}?today=${TODAY}`, { area: 'Core' })).statusCode).toBe(
        404,
      );
      expect((await other.inject('DELETE', `/focus/blocks/${mine?.id}`)).statusCode).toBe(404);
      expect((await other.inject('GET', `/focus/blocks/${mine?.id}/summary`)).statusCode).toBe(404);
      expect((await user.list()).map((block) => block.id)).toContain(mine?.id);
    });
  });

  describe('validation', () => {
    const user = as('focus-e2e-validation');

    it.each([
      ['a missing today', '/focus/blocks'],
      ['a malformed today', '/focus/blocks?today=10/25/2026'],
      ['a day the month does not have', '/focus/blocks?today=2026-02-30'],
    ])('400s on %s', async (_label, url) => {
      expect((await user.inject('GET', url)).statusCode).toBe(400);
    });

    it.each([
      ['an unknown area', { area: 'Forearms' }],
      ['a start that is not an ISO date', { start: 'October' }],
      ['a start the month does not have', { start: '2026-02-30' }],
      ['a primitive timer', { timer: 60 }],
      ['a negative timer value', { timer: { prep: -1, set: 40, rest: 45 } }],
      ['an unknown include', { pool: [entry('Hammer Curl', { include: 'sometimes' as 'auto' })] }],
      ['zero sets', { pool: [entry('Hammer Curl', { sets: 0 })] }],
      ['a percent over 100', { pool: [entry('Hammer Curl', { percent: 120 })] }],
      ['a primitive pool entry', { pool: ['Hammer Curl'] }],
      ['an unknown pool field', { pool: [{ ...entry('Hammer Curl'), note: 'x' }] }],
      ['an unknown block field', { status: 'active' }],
      ['an oversized pool', { pool: Array.from({ length: 21 }, (_, i) => entry(`Lift ${i}`)) }],
    ])('rejects a block with %s', async (_label, overrides) => {
      expect((await user.create(blockBody(overrides))).statusCode).toBe(400);
    });

    it('rejects a null on an update field that takes no null', async () => {
      const created = (await user.create(blockBody())).json() as FocusBlockResponse;
      const res = await user.inject('PATCH', `/focus/blocks/${created.id}?today=${TODAY}`, { area: null });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('auto-roll successors', () => {
    const user = as('focus-e2e-rollover');
    let predecessorId = '';

    it('creates the successor of an ended auto-roll block on read, once', async () => {
      const created = (
        await user.create(
          blockBody({ area: 'Chest', start: '2026-07-01', onEnd: 'autoroll', nextArea: 'Back', pool: [entry('Cable Fly')] }),
        )
      ).json() as FocusBlockResponse;
      predecessorId = created.id;

      const list = await user.list();
      expect(list).toHaveLength(2);
      const successor = list.find((block) => block.id !== predecessorId);
      expect(successor).toMatchObject({
        series: created.series,
        area: 'Back',
        start: '2026-10-01',
        status: 'active',
        onEnd: 'prompt',
        nextArea: null,
        pool: defaultFocusPool('Back'),
      });
      expect(successor?.id).toMatch(/^[0-9a-f-]{36}$/);

      // A second read finds the successor stored and creates nothing more.
      expect((await user.list()).map((block) => block.id).sort()).toEqual(list.map((block) => block.id).sort());
    });

    it('declines a successor on delete, so the next read does not recreate it', async () => {
      const successor = (await user.list()).find((block) => block.id !== predecessorId);
      expect((await user.inject('DELETE', `/focus/blocks/${successor?.id}`)).statusCode).toBe(204);
      const list = await user.list();
      expect(list.map((block) => block.id)).toEqual([predecessorId]);
      expect(list[0]?.onEnd).toBe('prompt');
    });
  });

  describe('daily focus guide', () => {
    const user = as('focus-e2e-settings');

    it('defaults, saves, and reads back the guide', async () => {
      expect((await user.inject('GET', '/focus/settings')).json()).toEqual(DEFAULT_FOCUS_BUDGET);
      const put = await user.inject('PUT', '/focus/settings', { sets: 12, minutes: 25 });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ sets: 12, minutes: 25 });
      expect((await user.inject('GET', '/focus/settings')).json()).toEqual({ sets: 12, minutes: 25 });
    });

    it.each([
      ['a negative value', { sets: -1, minutes: 20 }],
      ['a fraction', { sets: 9.5, minutes: 20 }],
      ['a missing value', { sets: 9 }],
    ])('rejects %s', async (_label, body) => {
      expect((await user.inject('PUT', '/focus/settings', body)).statusCode).toBe(400);
    });
  });

  describe('workout focus state', () => {
    const user = as('focus-e2e-state');
    const url = (workoutNum: number) => `/programs/${PROGRAM}/workouts/${workoutNum}/focus-state`;
    const saved: FocusDayState = {
      modes: { b1: 'pick' },
      picks: { b1: ['Hammer Curl'] },
      trims: { b2: ['Seated Calf Raise'] },
      placement: 'interleave',
      order: ['Squat', 'Hammer Curl'],
      dismissed: true,
    };

    it('reads the empty state before anything is saved', async () => {
      const res = await user.inject('GET', url(1));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(EMPTY_FOCUS_DAY_STATE);
    });

    it('saves per workout, and does not leak to another workout or user', async () => {
      const put = await user.inject('PUT', url(1), saved);
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual(saved);
      expect((await user.inject('GET', url(1))).json()).toEqual(saved);
      expect((await user.inject('GET', url(2))).json()).toEqual(EMPTY_FOCUS_DAY_STATE);
      expect((await as('focus-e2e-state-other').inject('GET', url(1))).json()).toEqual(EMPTY_FOCUS_DAY_STATE);
    });

    it.each([
      ['an unknown mode', { ...saved, modes: { b1: 'sometimes' } }],
      ['a pick list that is not strings', { ...saved, picks: { b1: [1] } }],
      ['an array for trims', { ...saved, trims: ['x'] }],
      ['an unknown placement', { ...saved, placement: 'middle' }],
      ['a missing field', { modes: {}, picks: {}, trims: {}, placement: 'after', order: null }],
    ])('rejects %s', async (_label, body) => {
      expect((await user.inject('PUT', url(1), body)).statusCode).toBe(400);
    });

    it('400s on a workoutNum that is not a positive integer', async () => {
      expect((await user.inject('GET', url(0))).statusCode).toBe(400);
      expect((await user.inject('GET', `/programs/${PROGRAM}/workouts/1.5/focus-state`)).statusCode).toBe(400);
    });
  });

  describe("a workout's focus plan", () => {
    const user = as('focus-e2e-plan');
    let plannedLifts: string[] = [];
    let calvesId = '';

    beforeAll(async () => {
      const workout = await user.inject('GET', `/programs/${PROGRAM}/workouts/1`);
      plannedLifts = (workout.json() as { lifts: { lift: string; planned: boolean }[] }).lifts
        .filter((lift) => lift.planned)
        .map((lift) => lift.lift);
      calvesId = ((await user.create(blockBody())).json() as FocusBlockResponse).id;
    });

    it("plans against the workout's own planned lifts, with prescriptions", async () => {
      expect(plannedLifts.length).toBeGreaterThan(0);
      const plan = await user.plan();
      expect(plan).toMatchObject({ program: PROGRAM, macrocycleNum: 1, workoutNum: 1, today: TODAY, plannedLifts });
      expect(plan.budget).toEqual(DEFAULT_FOCUS_BUDGET);
      expect(plan.groups).toHaveLength(1);
      const [group] = plan.groups;
      expect(group?.block.id).toBe(calvesId);
      expect(group?.overlap).toBeNull();
      expect(group?.items.map((item) => [item.lift, item.sets])).toEqual([
        ['Standing Calf Raise', 4],
        ['Seated Calf Raise', 3],
      ]);
      expect(group?.items[0]?.prescription).toEqual({
        progression: 'double',
        sets: 4,
        repsLow: 10,
        repsHigh: 12,
        weight: 25,
        lastReps: null,
      });
      expect(plan.sets).toBe(7);
      expect(plan.over).toBe(false);
    });

    it('leaves out blocks that are not active on the day', async () => {
      expect((await user.plan(1, '2027-01-01')).groups).toEqual([]);
    });

    it("applies the user's muscle overrides to overlap", async () => {
      const lift = plannedLifts[0] ?? '';
      const patched = await user.inject('PATCH', `/lifts/${encodeURIComponent(lift)}/metadata`, {
        muscleGroups: ['Calves'],
      });
      expect(patched.statusCode).toBe(200);
      const [group] = (await user.plan()).groups;
      expect(group?.overlap).toEqual({ lifts: [lift], mode: 'reduce' });
      expect(group?.items.map((item) => [item.lift, item.sets, item.reducedFrom])).toEqual([
        ['Standing Calf Raise', 3, 4],
        ['Seated Calf Raise', 2, 3],
      ]);
      await user.inject('PATCH', `/lifts/${encodeURIComponent(lift)}/metadata`, { muscleGroups: [] });
    });

    it('rounds a percent-of-training-max weight to the program increment', async () => {
      await user.inject('PATCH', `/focus/blocks/${calvesId}?today=${TODAY}`, {
        progression: 'tm',
        pool: [entry('Standing Calf Raise', { trainingMax: 251, percent: 60 })],
      });
      const spec = (await user.inject('GET', `/programs/${PROGRAM}/spec`)).json() as {
        week: number;
        offset: number;
        increment: number;
      }[];
      const increment = spec.find((row) => row.week === 1 && row.offset === 0)?.increment ?? NaN;
      const [group] = (await user.plan()).groups;
      // 251 × 60% = 150.6, rounded to a loadable plate combination.
      expect(group?.items[0]?.prescription).toEqual({
        progression: 'tm',
        sets: 3,
        reps: 12,
        weight: MROUND(150.6, increment),
        percent: 60,
        trainingMax: 251,
      });
      expect(MROUND(150.6, increment)).not.toBe(150.6);
    });

    it('rotates by workout number, so a large pool cycles across weeks', async () => {
      await user.inject('PATCH', `/focus/blocks/${calvesId}?today=${TODAY}`, {
        selection: 'rotate',
        progression: 'double',
        pool: [entry('A'), entry('B'), entry('C'), entry('D'), entry('E')],
      });
      const picks: string[] = [];
      for (const workoutNum of [1, 2, 3, 4, 5]) {
        picks.push((await user.plan(workoutNum)).groups[0]?.items[0]?.lift ?? '');
      }
      expect(picks).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    it("applies the day's saved trims and suggests a trim when over the guide", async () => {
      await user.inject('PATCH', `/focus/blocks/${calvesId}?today=${TODAY}`, {
        selection: 'rules',
        pool: [entry('Standing Calf Raise', { sets: 4 }), entry('Seated Calf Raise', { sets: 4 })],
      });
      await user.inject('PUT', '/focus/settings', { sets: 6, minutes: 60 });
      const over = await user.plan();
      expect(over.over).toBe(true);
      expect(over.suggestion).toMatchObject({ blockId: calvesId, lift: 'Seated Calf Raise', sets: 4 });

      await user.inject('PUT', `/programs/${PROGRAM}/workouts/1/focus-state`, {
        ...EMPTY_FOCUS_DAY_STATE,
        trims: { [calvesId]: ['Seated Calf Raise'] },
      });
      const trimmed = await user.plan();
      expect(trimmed.groups[0]?.trimmed).toEqual(['Seated Calf Raise']);
      expect(trimmed.sets).toBe(4);
      expect(trimmed.over).toBe(false);
      expect(trimmed.dayState.trims).toEqual({ [calvesId]: ['Seated Calf Raise'] });
    });

    it('400s on a workout past the program, and without today', async () => {
      expect((await user.inject('GET', `/programs/${PROGRAM}/workouts/9999/focus?today=${TODAY}`)).statusCode).toBe(400);
      expect((await user.inject('GET', `/programs/${PROGRAM}/workouts/1/focus`)).statusCode).toBe(400);
    });
  });

  describe('focus block summary', () => {
    const user = as('focus-e2e-summary');
    const log = (date: string, lift: string, weight: number, reps: number, setNum = 1) =>
      user.inject('POST', `/programs/${PROGRAM}/lift-records`, {
        macrocycleNum: 1,
        workoutNum: 1,
        date,
        lift,
        setNum,
        weight,
        reps,
      });

    it('totals pool-lift sets inside the range, with PRs against earlier bests', async () => {
      for (const res of [
        await log('2026-09-15', 'Hammer Curl', 30, 12),
        await log('2026-10-05', 'Hammer Curl', 35, 10),
        await log('2026-10-05', 'Hammer Curl', 35, 9, 2),
        await log('2026-10-12', 'Incline DB Curl', 20, 12),
        await log('2026-10-12', 'Squat', 300, 5),
        await log('2026-11-02', 'Hammer Curl', 40, 8),
      ]) {
        expect(res.statusCode).toBe(201);
      }
      const block = (
        await user.create(
          blockBody({
            area: 'Biceps',
            period: 'monthly',
            pool: [entry('Hammer Curl'), entry('Incline DB Curl')],
          }),
        )
      ).json() as FocusBlockResponse;

      const res = await user.inject('GET', `/focus/blocks/${block.id}/summary`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual<FocusBlockSummaryResponse>({
        blockId: block.id,
        rangeStart: '2026-10-01',
        rangeEnd: '2026-10-31',
        sessions: 2,
        sets: 3,
        volume: 35 * 10 + 35 * 9 + 20 * 12,
        prs: [{ lift: 'Hammer Curl', weight: 35, reps: 10, previousWeight: 30, previousReps: 12 }],
      });
    });

    it("counts a custom lift's records stored under its id", async () => {
      const custom = await user.inject('POST', '/lifts/custom', { name: 'Spider Curl', classification: 'accessory' });
      expect(custom.statusCode).toBe(201);
      const { id } = custom.json() as { id: string };
      expect((await log('2026-10-20', id, 25, 10)).statusCode).toBe(201);
      const block = (
        await user.create(blockBody({ area: 'Biceps', period: 'monthly', series: 'spider', pool: [entry('Spider Curl')] }))
      ).json() as FocusBlockResponse;
      const summary = (await user.inject('GET', `/focus/blocks/${block.id}/summary`)).json() as FocusBlockSummaryResponse;
      expect(summary).toMatchObject({ sessions: 1, sets: 1, volume: 250 });
    });
  });
});
