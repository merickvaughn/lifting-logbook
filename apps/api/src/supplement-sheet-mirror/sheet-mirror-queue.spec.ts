import { CloudTasksSheetMirrorQueue, ENQUEUE_TIMEOUT_MS } from './sheet-mirror-queue';

/** The Cloud Tasks enqueue (#1443, ADR-047 decision 16), against a fake metadata server and API. */

const ENV = {
  SHEET_MIRROR_QUEUE: 'supplement-sheet-mirror',
  SHEET_MIRROR_QUEUE_LOCATION: 'us-central1',
  SHEET_MIRROR_TASKS_SA_EMAIL: 'sheet-mirror-tasks@proj.iam.gserviceaccount.com',
  SHEET_MIRROR_API_URL: 'https://api.example.run.app',
};
const saved: Record<string, string | undefined> = {};

/**
 * Answers each request after `delayMs`, or rejects when its signal aborts first, as fetch does.
 * Records each URL it was asked for.
 */
function fakeFetch(delayMs: number, tasksStatus = 200, expiresIn = 3600) {
  const urls: string[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const body = url.endsWith('project-id')
      ? 'proj-1\n'
      : url.endsWith('/token')
        ? JSON.stringify({ access_token: 'ya29.metadata-token', expires_in: expiresIn })
        : '{}';
    const status = url.includes('cloudtasks') ? tasksStatus : 200;
    return new Promise((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => resolve(new Response(body, { status })), delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
  };
  return { impl: impl as typeof fetch, urls };
}

const count = (urls: string[], part: string) => urls.filter((u) => u.includes(part)).length;

describe('CloudTasksSheetMirrorQueue', () => {
  beforeAll(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('gives the whole enqueue one 2 s timeout, not 2 s per call', async () => {
    // Each call alone is well inside 2 s; the three in a row are not.
    const step = Math.ceil(ENQUEUE_TIMEOUT_MS * 0.45);
    const { impl, urls } = fakeFetch(step);
    const started = Date.now();
    await expect(new CloudTasksSheetMirrorQueue(impl).enqueue('user-1')).rejects.toMatchObject({ name: 'TimeoutError' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(ENQUEUE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(ENQUEUE_TIMEOUT_MS + 500);
    expect(urls).toHaveLength(3);
  });

  it('fetches the project ID and the access token once for many enqueues', async () => {
    const { impl, urls } = fakeFetch(0);
    const queue = new CloudTasksSheetMirrorQueue(impl);
    await queue.enqueue('user-1');
    await queue.enqueue('user-2');
    await queue.enqueue('user-3');
    expect(count(urls, 'project-id')).toBe(1);
    expect(count(urls, '/token')).toBe(1);
    expect(count(urls, 'cloudtasks.googleapis.com/v2/projects/proj-1/locations/us-central1/queues/supplement-sheet-mirror/tasks')).toBe(3);
  });

  it('fetches the access token again a minute before it expires', async () => {
    let now = Date.parse('2026-11-23T12:00:00Z');
    const { impl, urls } = fakeFetch(0, 200, 600);
    const queue = new CloudTasksSheetMirrorQueue(impl, () => now);
    await queue.enqueue('user-1');
    now += 539_000;
    await queue.enqueue('user-1');
    expect(count(urls, '/token')).toBe(1);
    now += 2_000;
    await queue.enqueue('user-1');
    expect(count(urls, '/token')).toBe(2);
    expect(count(urls, 'project-id')).toBe(1);
  });

  it('counts ALREADY_EXISTS as success and throws any other failure with its status only', async () => {
    await expect(new CloudTasksSheetMirrorQueue(fakeFetch(0, 409).impl).enqueue('user-1')).resolves.toBeUndefined();
    await expect(new CloudTasksSheetMirrorQueue(fakeFetch(0, 403).impl).enqueue('user-1')).rejects.toThrow('Cloud Tasks create: 403');
  });
});
