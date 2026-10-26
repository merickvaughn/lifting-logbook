/** @jest-environment node */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

// The Playwright mock API (e2e/mock-api.mjs) must mirror the real Fastify API's rejection of an
// empty or malformed JSON body with a 400 (FST_ERR_CTP_EMPTY_JSON_BODY / parse error — #667).
// Before #699 it swallowed both into `{}` and returned 200/201, so a client bug that sent a
// broken body passed the mock-backed tests while failing against the real API. This exercises
// the mock over real HTTP (it starts a listener on import, so it is spawned as a child process
// rather than imported). See #687 / #699.

// Run the mock on a dedicated port so this unit test never collides with a running
// Playwright/dev mock on the default 3004 (mock-api.mjs honours MOCK_API_PORT).
const PORT = 3105;
// 127.0.0.1 (not localhost): IPv4-only mock bind + Windows localhost -> ::1 (#741, CLAUDE.md).
const BASE = `http://127.0.0.1:${PORT}`;
let mock: ChildProcess | undefined;

async function waitForReady(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/__reset`);
      if (res.ok) return;
    } catch {
      /* server not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('mock-api did not become ready on :3004');
}

function jsonRequest(path: string, method: string, body?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
  });
}

describe('mock-api JSON body fidelity (#699)', () => {
  beforeAll(async () => {
    mock = spawn(process.execPath, [join(__dirname, 'mock-api.mjs')], {
      stdio: 'ignore',
      env: { ...process.env, MOCK_API_PORT: String(PORT) },
    });
    await waitForReady();
  }, 25000);

  afterAll(() => {
    mock?.kill();
  });

  it('rejects a malformed JSON body with 400 (like real Fastify), not a swallowed 200', async () => {
    const res = await jsonRequest('/programs/rpt/lift-records', 'POST', '{not json');
    expect(res.status).toBe(400);
  });

  it('rejects an empty JSON body with 400', async () => {
    const res = await jsonRequest('/programs/rpt/lift-records', 'POST');
    expect(res.status).toBe(400);
  });

  it('still accepts a valid JSON body (201)', async () => {
    const res = await jsonRequest(
      '/programs/rpt/lift-records',
      'POST',
      JSON.stringify({ lift: 'squat', weight: 100 }),
    );
    expect(res.status).toBe(201);
  });

  it('rejects a malformed body on PATCH training-maxes with 400', async () => {
    const res = await jsonRequest('/programs/rpt/training-maxes', 'PATCH', 'nope');
    expect(res.status).toBe(400);
  });

  it('leaves body-less endpoints unaffected (switch → 200)', async () => {
    const res = await jsonRequest('/programs/rpt/switch', 'POST');
    expect(res.status).toBe(200);
  });

  // The focus setup page's Playwright spec runs against these routes (#1057), so they must
  // keep the real API's contract: `?today=` required, status derived from the dates, the
  // reorder listing every block not ended, and Cancel declining the roll it covered.
  describe('focus routes (#1057)', () => {
    const TODAY = '2026-10-26';
    const NEW_BLOCK = {
      area: 'Triceps',
      period: 'monthly',
      align: 'calendar',
      start: '2026-10-01',
      selection: 'rules',
      overlap: 'reduce',
      progression: 'double',
      timer: { prep: 10, set: 45, rest: 60 },
      onEnd: 'prompt',
      nextArea: null,
      pool: [],
    };

    beforeEach(async () => {
      await fetch(`${BASE}/__reset`);
    });

    async function create(body: object): Promise<{ id: string; status: string; priority: number }> {
      const res = await jsonRequest(`/focus/blocks?today=${TODAY}`, 'POST', JSON.stringify(body));
      expect(res.status).toBe(201);
      return res.json();
    }

    it('requires today on block reads', async () => {
      expect((await fetch(`${BASE}/focus/blocks`)).status).toBe(400);
    });

    it('creates, lists with derived status, and patches focus blocks', async () => {
      const created = await create(NEW_BLOCK);
      expect(created).toMatchObject({ status: 'active', priority: 1, rangeEnd: '2026-10-31' });

      const patched = await jsonRequest(
        `/focus/blocks/${created.id}?today=${TODAY}`,
        'PATCH',
        JSON.stringify({ period: 'quarterly' }),
      );
      expect(await patched.json()).toMatchObject({ period: 'quarterly', rangeEnd: '2026-12-31' });

      const list = await (await fetch(`${BASE}/focus/blocks?today=2027-01-05`)).json();
      expect(list).toEqual([expect.objectContaining({ id: created.id, status: 'ended' })]);
    });

    it('reorders only with every block not ended, exactly once', async () => {
      const a = await create(NEW_BLOCK);
      const b = await create({ ...NEW_BLOCK, area: 'Core' });
      const bad = await jsonRequest(`/focus/blocks/order?today=${TODAY}`, 'PUT', JSON.stringify({ ids: [b.id] }));
      expect(bad.status).toBe(400);

      const ok = await jsonRequest(`/focus/blocks/order?today=${TODAY}`, 'PUT', JSON.stringify({ ids: [b.id, a.id] }));
      const blocks: { id: string; priority: number }[] = await ok.json();
      expect(Object.fromEntries(blocks.map((x) => [x.id, x.priority]))).toEqual({ [b.id]: 1, [a.id]: 2 });
    });

    it('declines the auto-roll a cancelled block covered', async () => {
      const shoulders = await create({ ...NEW_BLOCK, area: 'Shoulders', onEnd: 'autoroll', nextArea: 'Back' });
      const next = await create({ ...NEW_BLOCK, series: shoulders.id, area: 'Back', start: '2026-11-01' });
      expect(next.status).toBe('queued');

      expect((await fetch(`${BASE}/focus/blocks/${next.id}`, { method: 'DELETE' })).status).toBe(204);
      const list = await (await fetch(`${BASE}/focus/blocks?today=${TODAY}`)).json();
      expect(list).toEqual([expect.objectContaining({ id: shoulders.id, onEnd: 'prompt' })]);
    });

    it('creates an auto-roll successor on read, once, as the API does', async () => {
      const shoulders = await create({ ...NEW_BLOCK, area: 'Shoulders', onEnd: 'autoroll', nextArea: 'Back' });
      const read = async () => (await fetch(`${BASE}/focus/blocks?today=${TODAY}`)).json();
      const first = await read();
      expect(first).toEqual([
        expect.objectContaining({ id: shoulders.id }),
        expect.objectContaining({ series: shoulders.id, area: 'Back', start: '2026-11-01', status: 'queued', onEnd: 'prompt' }),
      ]);
      expect(await read()).toHaveLength(2);
    });

    it('stores the daily focus guide', async () => {
      const put = await jsonRequest('/focus/settings', 'PUT', JSON.stringify({ sets: 12, minutes: 25 }));
      expect(put.status).toBe(200);
      expect(await (await fetch(`${BASE}/focus/settings`)).json()).toEqual({ sets: 12, minutes: 25 });
    });

    it("plans a workout's focus work from the active blocks against the guide", async () => {
      await create({
        ...NEW_BLOCK,
        pool: [
          { lift: 'Rope Pushdown', include: 'auto', ruleLift: '', swapTo: '', sets: 3, repsLow: 10, repsHigh: 12, weight: 25, trainingMax: 40, percent: 65, rpe: 8 },
          { lift: 'Skull Crusher', include: 'off', ruleLift: '', swapTo: '', sets: 3, repsLow: 10, repsHigh: 12, weight: 25, trainingMax: 40, percent: 65, rpe: 8 },
        ],
      });
      const plan = await (await fetch(`${BASE}/programs/rpt/workouts/2/focus?today=${TODAY}`)).json();
      expect(plan.groups[0].items.map((i: { lift: string }) => i.lift)).toEqual(['Rope Pushdown']);
      // 3 × (10 + 45) + 2 × 60 between sets + 60 after: 345 s.
      expect(plan).toMatchObject({ workoutNum: 2, sets: 3, seconds: 345, over: false });
    });

    it('rejects a malformed focus body with 400', async () => {
      const res = await jsonRequest(`/focus/blocks?today=${TODAY}`, 'POST', '{nope');
      expect(res.status).toBe(400);
    });
  });
});
