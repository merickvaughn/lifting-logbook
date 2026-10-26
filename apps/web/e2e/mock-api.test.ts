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

describe('mock-api JSON body fidelity (#699)', () => {
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
});

// The calendar's Playwright spec (#1059) reads these routes; they mirror the real API's
// derived status and range (core's blockRange/blockStatus) and its Cancel semantics (ADR-039).
describe('mock-api focus blocks (#1059)', () => {
  interface Block {
    id: string;
    area: string;
    status: string;
    rangeStart: string;
    rangeEnd: string;
    onEnd: string;
  }
  async function blocks(today: string): Promise<Block[]> {
    const res = await fetch(`${BASE}/focus/blocks?today=${today}`);
    const data: Block[] = await res.json();
    return data;
  }

  beforeEach(async () => {
    await fetch(`${BASE}/__reset?withFocusBlocks=2025-01-23`);
  });

  afterAll(async () => {
    await fetch(`${BASE}/__reset`);
  });

  it('has no focus blocks unless seeded', async () => {
    await fetch(`${BASE}/__reset`);
    expect(await blocks('2025-01-23')).toEqual([]);
  });

  it('derives each focus block’s range and status from today', async () => {
    const byId = Object.fromEntries((await blocks('2025-01-23')).map((b) => [b.id, b]));
    expect(byId['fb-shoulders']).toMatchObject({ status: 'active', rangeStart: '2025-01-01', rangeEnd: '2025-03-31' });
    expect(byId['fb-back']).toMatchObject({ status: 'queued', rangeStart: '2025-04-01', rangeEnd: '2025-06-30' });
    expect(byId['fb-biceps']).toMatchObject({ status: 'active', rangeEnd: '2025-01-31' });
    expect(byId['fb-biceps-prev']).toMatchObject({ status: 'ended', rangeStart: '2024-12-01' });
  });

  it('requires today', async () => {
    expect((await fetch(`${BASE}/focus/blocks`)).status).toBe(400);
  });

  it('creates a focus block in the given series', async () => {
    const res = await jsonRequest(
      '/focus/blocks?today=2025-01-23',
      'POST',
      JSON.stringify({ series: 'fs-2', area: 'Biceps', period: 'monthly', align: 'calendar', start: '2025-02-01' }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ series: 'fs-2', status: 'queued', rangeEnd: '2025-02-28' });
  });

  it('rejects a malformed create body with 400', async () => {
    expect((await jsonRequest('/focus/blocks?today=2025-01-23', 'POST', '{nope')).status).toBe(400);
  });

  it('cancels a queued successor and stops its predecessor rolling', async () => {
    expect((await fetch(`${BASE}/focus/blocks/fb-back`, { method: 'DELETE' })).status).toBe(204);
    const after = await blocks('2025-01-23');
    expect(after.map((b) => b.id)).not.toContain('fb-back');
    expect(after.find((b) => b.id === 'fb-shoulders')?.onEnd).toBe('prompt');
  });

  it('keeps the predecessor rolling when a later focus block still covers its roll', async () => {
    // A third quarter in the series covers the roll whether or not Back is there.
    await jsonRequest(
      '/focus/blocks?today=2025-01-23',
      'POST',
      JSON.stringify({ series: 'fs-1', area: 'Core', period: 'quarterly', align: 'calendar', start: '2025-07-01' }),
    );
    await fetch(`${BASE}/focus/blocks/fb-back`, { method: 'DELETE' });
    expect((await blocks('2025-01-23')).find((b) => b.id === 'fb-shoulders')?.onEnd).toBe('autoroll');
  });

  it('never reuses a created id after a delete', async () => {
    const create = async () => {
      const res = await jsonRequest(
        '/focus/blocks?today=2025-01-23',
        'POST',
        JSON.stringify({ area: 'Core', period: 'monthly', align: 'calendar', start: '2025-03-01' }),
      );
      const created: Block = await res.json();
      return created.id;
    };
    const first = await create();
    await fetch(`${BASE}/focus/blocks/${first}`, { method: 'DELETE' });
    expect(await create()).not.toBe(first);
  });

  it('returns an ended focus block’s summary, and 404 for an unknown one', async () => {
    const res = await fetch(`${BASE}/focus/blocks/fb-biceps-prev/summary`);
    expect(await res.json()).toMatchObject({ blockId: 'fb-biceps-prev', rangeStart: '2024-12-01', sessions: 12 });
    expect((await fetch(`${BASE}/focus/blocks/nope/summary`)).status).toBe(404);
  });
});
