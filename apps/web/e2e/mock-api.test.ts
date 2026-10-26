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

  describe('focus work routes (#1058)', () => {
    const FOCUS = '/programs/5-3-1/workouts/1/focus';
    const STATE = '/programs/5-3-1/workouts/1/focus-state';
    const DAY_STATE = { modes: {}, picks: {}, trims: {}, placement: 'after', order: null, dismissed: false };

    afterEach(async () => {
      await fetch(`${BASE}/__reset`);
    });

    it('requires today, as the real API does', async () => {
      expect((await fetch(`${BASE}${FOCUS}`)).status).toBe(400);
      expect((await fetch(`${BASE}${FOCUS}?today=2026-10-26`)).status).toBe(200);
    });

    it('plans no focus work by default, so other specs see a plain workout', async () => {
      const plan = await (await fetch(`${BASE}${FOCUS}?today=2026-10-26`)).json();
      expect(plan.groups).toEqual([]);
      expect(plan.dayState).toEqual(DAY_STATE);
    });

    it('plans an over-guide focus block once opted in, and applies saved trims', async () => {
      await fetch(`${BASE}/__reset?withFocus=true`);
      const before = await (await fetch(`${BASE}${FOCUS}?today=2026-10-26`)).json();
      expect(before.groups[0].items.map((i: { lift: string }) => i.lift)).toEqual(['Lateral Raise', 'Face Pull', 'Arnold Press']);
      expect(before).toMatchObject({ sets: 9, over: true, suggestion: { lift: 'Arnold Press', sets: 6 } });

      const trimmed = { ...DAY_STATE, trims: { 'fb-shoulders': ['Arnold Press'] } };
      expect((await jsonRequest(STATE, 'PUT', JSON.stringify(trimmed))).status).toBe(200);

      const after = await (await fetch(`${BASE}${FOCUS}?today=2026-10-26`)).json();
      expect(after).toMatchObject({ sets: 6, over: false, suggestion: null, dayState: trimmed });
      expect(after.groups[0].trimmed).toEqual(['Arnold Press']);
      expect(await (await fetch(`${BASE}${STATE}`)).json()).toEqual(trimmed);
    });

    it('fails the plan when asked to', async () => {
      await fetch(`${BASE}/__reset?withFocusError=true`);
      expect((await fetch(`${BASE}${FOCUS}?today=2026-10-26`)).status).toBe(500);
    });

    it('rejects a malformed or invalid day state with 400', async () => {
      expect((await jsonRequest(STATE, 'PUT', '{nope')).status).toBe(400);
      expect((await jsonRequest(STATE, 'PUT', JSON.stringify({ ...DAY_STATE, placement: 'sideways' }))).status).toBe(400);
    });
  });
});
