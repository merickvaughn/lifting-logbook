import { emptyFocusDayState, type CreateFocusBlockRequest } from '@lifting-logbook/types';
import { createApiClient } from './index';

const AUTH = { Authorization: 'Bearer identity', 'X-Clerk-Authorization': 'Bearer clerk' };

const mockFetch = jest.fn<Promise<Response>, [string, RequestInit?]>();

function makeClient() {
  return createApiClient({
    baseUrl: 'http://api.test',
    getAuthHeaders: async () => ({ ...AUTH }),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

function lastCall(): [string, RequestInit] {
  const calls = mockFetch.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) throw new Error('fetch was not called');
  return [call[0], call[1] ?? {}];
}

describe('createApiClient', () => {
  describe('request plumbing', () => {
    it('prefixes baseUrl and merges auth headers with a call-site header (auth-wins)', async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
      const client = makeClient();
      await client.rescheduleWorkout('5-3-1', 1, 2, '2026-07-01');

      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/programs/5-3-1/macrocycles/1/workouts/2/reschedule');
      expect(init.method).toBe('PATCH');
      // Content-Type from the call site coexists with both injected auth headers.
      expect(init.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer identity',
        'X-Clerk-Authorization': 'Bearer clerk',
      });
    });

    it('auth headers override a colliding call-site Authorization header', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      // A strategy that returns Authorization must win over anything a method set.
      const client = createApiClient({
        baseUrl: 'http://api.test',
        getAuthHeaders: async () => ({ Authorization: 'Bearer WINS' }),
      });
      await client.fetchTrainingMaxes('5-3-1');
      const [, init] = lastCall();
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer WINS');
    });

    it('resolves a thunk baseUrl per request (runtime-injected URL — #396)', async () => {
      // Fresh Response per call: a Response body can only be read once.
      mockFetch.mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 }));
      // The browser client passes a getter so the base URL can change after construction
      // (e.g. once window.__PUBLIC_CONFIG__ is populated). Each request re-reads it.
      let current = 'http://first.test';
      const client = createApiClient({
        baseUrl: () => current,
        getAuthHeaders: async () => ({ ...AUTH }),
      });

      await client.fetchTrainingMaxes('5-3-1');
      expect(lastCall()[0]).toBe('http://first.test/programs/5-3-1/training-maxes');

      current = 'http://second.test';
      await client.fetchTrainingMaxes('5-3-1');
      expect(lastCall()[0]).toBe('http://second.test/programs/5-3-1/training-maxes');
    });

    it('encodes path segments', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
      const client = makeClient();
      await client.fetchLiftMetadata('Front Squat/Variant');
      const [url] = lastCall();
      expect(url).toBe('http://api.test/lifts/Front%20Squat%2FVariant/metadata');
    });

    it('lists every lift metadata row from one path', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      const client = makeClient();
      await expect(client.fetchAllLiftMetadata()).resolves.toEqual([]);
      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/lifts/metadata');
      expect((init as { cache?: string }).cache).toBe('no-store');
    });

    it('forwards the Next.js revalidate directive for cacheable reads', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      const client = makeClient();
      await client.fetchProgramSpec('5-3-1');
      const [, init] = lastCall();
      expect((init as { next?: { revalidate?: number } }).next).toEqual({ revalidate: 3600 });
    });

    it('throws the joined NestJS validation message on a 400', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: ['too short', 'must be a number'] }), {
          status: 400,
        }),
      );
      const client = makeClient();
      await expect(client.fetchTrainingMaxes('5-3-1')).rejects.toThrow(
        'too short; must be a number',
      );
    });

    it('falls back to a generic message when the error body has no message field', async () => {
      mockFetch.mockResolvedValue(new Response('not json', { status: 500, statusText: 'Boom' }));
      const client = makeClient();
      await expect(client.fetchTrainingMaxes('5-3-1')).rejects.toThrow(
        'API 500 Boom for /programs/5-3-1/training-maxes',
      );
    });

    it('returns undefined for a 204 No Content response', async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
      const client = makeClient();
      await expect(client.unskipWorkout('5-3-1', 1, 2)).resolves.toBeUndefined();
    });

    it('passes an AbortSignal on every request even though no call site supplies one', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      const client = makeClient();
      await client.fetchTrainingMaxes('5-3-1');
      const [, init] = lastCall();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.signal as AbortSignal).aborted).toBe(false);
    });

    it('bounds a request that never settles with the configured timeout (#922)', async () => {
      // global.fetch is fully replaced by mockFetch, so it must mirror real
      // fetch's own signal contract itself (reject with the abort reason once
      // the signal aborts) — otherwise a signal nothing listens to would never
      // cause this mock's returned promise to settle, same as the bug this
      // guards against: a hung connection with no default timeout left the
      // caller's `await` pending forever (ImportWizard's remap-row `busy` state
      // never cleared, permanently disabling that row's controls).
      mockFetch.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return; // no signal wired up at all — would hang forever
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );
      const client = createApiClient({
        baseUrl: 'http://api.test',
        getAuthHeaders: async () => ({ ...AUTH }),
        requestTimeoutMs: 25,
      });

      await expect(client.fetchTrainingMaxes('5-3-1')).rejects.toThrow(/timeout/i);
    });
  });

  describe('nullable reads', () => {
    it('returns null on 404 instead of throwing', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 404 }));
      const client = makeClient();
      await expect(client.fetchMacrocycleDashboard('5-3-1')).resolves.toBeNull();
    });

    it('returns the parsed body on 200', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ program: '5-3-1', macrocycleNum: 3 }), { status: 200 }),
      );
      const client = makeClient();
      await expect(client.fetchMacrocycleDashboard('5-3-1')).resolves.toEqual({
        program: '5-3-1',
        macrocycleNum: 3,
      });
    });

    it('throws on a non-404 error', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ message: 'boom' }), { status: 500 }));
      const client = makeClient();
      await expect(client.fetchWorkout('5-3-1', 1)).rejects.toThrow('boom');
    });
  });

  describe('idempotent deletes', () => {
    it('resolves when the resource is already absent (404)', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 404 }));
      const client = makeClient();
      await expect(client.deleteStrengthGoal('5-3-1', 'Squat')).resolves.toBeUndefined();
    });

    it('throws on a non-404 failure', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ message: 'denied' }), { status: 403 }));
      const client = makeClient();
      await expect(client.deleteCustomProgram('p1')).rejects.toThrow('denied');
    });
  });

  describe('conflict-tolerant POSTs (initializeMacrocycle)', () => {
    it('returns null on 409 Conflict instead of throwing', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: 'A macrocycle for "rpt" already exists.' }), { status: 409 }),
      );
      const client = makeClient();
      await expect(client.initializeMacrocycle('rpt')).resolves.toBeNull();
    });

    it('returns the parsed dashboard on 200', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ program: 'rpt', macrocycleNum: 1 }), { status: 200 }),
      );
      const client = makeClient();
      await expect(client.initializeMacrocycle('rpt')).resolves.toMatchObject({ program: 'rpt', macrocycleNum: 1 });
    });

    it('throws on a non-409 error', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: 'server exploded' }), { status: 500 }),
      );
      const client = makeClient();
      await expect(client.initializeMacrocycle('rpt')).rejects.toThrow('server exploded');
    });
  });

  describe('conflict-with-reason POSTs (createCustomLift)', () => {
    // Unlike initializeMacrocycle's single conflict cause, custom-lift creation
    // 409s for two distinct, both-true reasons (a duplicate name vs. a name
    // reserved by a canonical alias) — so this endpoint must surface the
    // server's actual message rather than collapsing to bare null (#917).
    it('returns { ok: false, conflictMessage } with the server message on 409, without throwing', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ message: "A custom lift named 'Curls' already exists" }),
          { status: 409 },
        ),
      );
      const client = makeClient();
      await expect(
        client.createCustomLift({ name: 'Curls', classification: 'accessory' }),
      ).resolves.toEqual({ ok: false, conflictMessage: "A custom lift named 'Curls' already exists" });
    });

    it('passes through a differently-worded 409 message unchanged (reserved-alias conflict)', async () => {
      // Same status code as the duplicate-name case above, deliberately
      // different message — proves the helper forwards whatever the server
      // says rather than assuming a single fixed wording for every 409.
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            message: "'Squat' is a reserved lift name and cannot be used for a custom lift",
          }),
          { status: 409 },
        ),
      );
      const client = makeClient();
      await expect(
        client.createCustomLift({ name: 'Squat', classification: 'compound' }),
      ).resolves.toEqual({
        ok: false,
        conflictMessage: "'Squat' is a reserved lift name and cannot be used for a custom lift",
      });
    });

    it('returns { ok: true, data } with the parsed body on 201', async () => {
      const lift = { id: 'custom-1', name: 'Curls', classification: 'accessory' };
      mockFetch.mockResolvedValue(new Response(JSON.stringify(lift), { status: 201 }));
      const client = makeClient();
      await expect(
        client.createCustomLift({ name: 'Curls', classification: 'accessory' }),
      ).resolves.toEqual({ ok: true, data: lift });
    });

    it('throws on a non-409 error', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: 'server exploded' }), { status: 500 }),
      );
      const client = makeClient();
      await expect(
        client.createCustomLift({ name: 'Curls', classification: 'accessory' }),
      ).rejects.toThrow('server exploded');
    });
  });

  describe('lift modifications (#1152)', () => {
    it("lists one lift's modifications by its encoded name", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      const client = makeClient();
      await expect(client.fetchLiftModifications('Bench P.')).resolves.toEqual([]);
      expect(mockFetch.mock.calls[0]?.[0]).toBe('http://api.test/lifts/modifications?lift=Bench%20P.');
    });

    it("lists several lifts' modifications in one request, one encoded `lift` per name (#1242)", async () => {
      const byLift = { 'Bench P.': [], 'Squat & Co': [] };
      mockFetch.mockResolvedValue(new Response(JSON.stringify(byLift), { status: 200 }));
      const client = makeClient();
      await expect(client.fetchLiftModificationsByLift(['Bench P.', 'Squat & Co'])).resolves.toEqual(byLift);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        'http://api.test/lifts/modifications/by-lift?lift=Bench%20P.&lift=Squat%20%26%20Co',
      );
    });

    it('returns the server message on a 409 create', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: "'Paused' already exists" }), { status: 409 }),
      );
      const client = makeClient();
      await expect(client.createLiftModification({ lift: 'Squat', name: 'Paused' })).resolves.toEqual({
        ok: false,
        conflictMessage: "'Paused' already exists",
      });
    });

    it('PATCHes a modification by its encoded id, and returns the message on a 409 (#1153)', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ message: "'Wide' already exists" }), { status: 409 }));
      const client = makeClient();
      await expect(client.updateLiftModification('m 1', { name: 'Wide', maxMode: 'own' })).resolves.toEqual({
        ok: false,
        conflictMessage: "'Wide' already exists",
      });
      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/lifts/modifications/m%201');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(JSON.stringify({ name: 'Wide', maxMode: 'own' }));
    });

    it("reads a program's own maxes, and PUTs one by modification (#1153)", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      const client = makeClient();
      await expect(client.fetchModificationMaxes('rpt')).resolves.toEqual([]);
      expect(lastCall()[0]).toBe('http://api.test/programs/rpt/modification-maxes');

      const max = { modificationId: 'm1', weight: 65, unit: 'lbs', dateUpdated: '2026-04-20' };
      mockFetch.mockResolvedValue(new Response(JSON.stringify(max), { status: 200 }));
      await expect(client.putModificationMax('rpt', 'm1', { weight: 65 })).resolves.toEqual(max);
      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/programs/rpt/modification-maxes/m1');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ weight: 65 }));
    });
  });

  describe('fetchGoogleSheetWorkbook (#1111)', () => {
    it('POSTs the pasted link as JSON and returns the tabs', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ tabs: [] }), { status: 200 }));
      const client = makeClient();
      const result = await client.fetchGoogleSheetWorkbook('rpt', 'https://docs.google.com/spreadsheets/d/abc/edit');

      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/programs/rpt/import/google-sheet');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ url: 'https://docs.google.com/spreadsheets/d/abc/edit' }));
      expect(result).toEqual({ tabs: [] });
    });

    it('throws with the server message so the UI can show sharing instructions', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ statusCode: 422, message: 'This sheet is not shared.' }), { status: 422 }),
      );
      await expect(makeClient().fetchGoogleSheetWorkbook('rpt', 'x')).rejects.toThrow('This sheet is not shared.');
    });
  });

  describe('downloadDataExport (#947)', () => {
    it('returns the archive as a blob, with auth and its own timeout', async () => {
      mockFetch.mockResolvedValue(new Response('zip-bytes', { status: 200 }));
      const timeout = jest.spyOn(AbortSignal, 'timeout');

      const blob = await makeClient().downloadDataExport();

      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/users/me/export');
      expect(init.headers).toEqual(AUTH);
      expect(timeout).toHaveBeenCalledWith(60_000);
      expect(init.signal).toBe(timeout.mock.results[0]!.value);
      expect(await blob.text()).toBe('zip-bytes');
      timeout.mockRestore();
    });

    it('throws with the server message and status on failure', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: 'No access' }), { status: 403 }),
      );

      await expect(makeClient().downloadDataExport()).rejects.toMatchObject({
        message: expect.stringContaining('No access'),
        status: 403,
      });
    });
  });

  describe('switchProgram', () => {
    it('sends a JSON body alongside the JSON content-type header (issue #665)', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ activeProgram: 'leangains', macrocycleNum: 1 }), { status: 200 }),
      );
      const client = makeClient();
      await client.switchProgram('leangains');

      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/programs/leangains/switch');
      expect(init.method).toBe('POST');
      // A Content-Type: application/json header with no body is rejected outright by Fastify's
      // JSON body parser in production — inject()-based E2E tests don't set Content-Type and so
      // never caught this. Assert on the constructed request shape directly instead.
      expect(init.body).toBe('{}');
    });

    it('resolves with the parsed response', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ activeProgram: 'leangains', macrocycleNum: 3 }), { status: 200 }),
      );
      const client = makeClient();
      await expect(client.switchProgram('leangains')).resolves.toEqual({
        activeProgram: 'leangains',
        macrocycleNum: 3,
      });
    });
  });

  describe('importLiftRecords', () => {
    const file = new File(['a,b\n1,2'], 'records.csv', { type: 'text/csv' });

    it('returns ok:true with data on 201', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ imported: 2 }), { status: 201 }),
      );
      const client = makeClient();
      const result = await client.importLiftRecords('5-3-1', file);
      expect(result).toEqual({ ok: true, data: { imported: 2 } });
      // FormData body must not carry a manual Content-Type (boundary is auto-set).
      const [, init] = lastCall();
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });

    it('returns ok:false with the server-reported row errors', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ row: 3, message: 'bad weight' }] }), {
          status: 400,
        }),
      );
      const client = makeClient();
      const result = await client.importLiftRecords('5-3-1', file);
      expect(result).toEqual({ ok: false, errors: [{ row: 3, message: 'bad weight' }] });
    });

    it('synthesizes a fallback error when the body omits errors', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 500 }));
      const client = makeClient();
      const result = await client.importLiftRecords('5-3-1', file);
      expect(result).toEqual({
        ok: false,
        errors: [{ row: 0, code: 'UNEXPECTED_ERROR', message: 'Unexpected error (HTTP 500)' }],
      });
    });
  });

  describe('imports while workouts are being saved (#1198)', () => {
    const file = new File(['a,b\n1,2'], 'records.csv', { type: 'text/csv' });
    const busy = (action: string) =>
      new Response(
        JSON.stringify({
          statusCode: 409,
          code: 'macrocycle-busy',
          message: `Your workouts are being saved. Try the ${action} again in a moment.`,
        }),
        { status: 409 },
      );
    const retry = [
      { row: 0, code: 'UNEXPECTED_ERROR', message: 'Your workouts are being saved. Try the import again in a moment.' },
    ];

    it('importLiftRecords shows the retry message of a 409 macrocycle-busy', async () => {
      mockFetch.mockResolvedValue(busy('import'));
      await expect(makeClient().importLiftRecords('5-3-1', file)).resolves.toEqual({ ok: false, errors: retry });
    });

    it('commitImport shows the retry message of a 409 macrocycle-busy', async () => {
      mockFetch.mockResolvedValue(busy('import'));
      await expect(makeClient().commitImport('5-3-1', file, 'lift-records')).resolves.toEqual({ ok: false, errors: retry });
    });

    it('commitImport keeps the generic message for a 409 with another code', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ code: 'other', message: 'no' }), { status: 409 }));
      await expect(makeClient().commitImport('5-3-1', file, 'lift-records')).resolves.toEqual({
        ok: false,
        errors: [{ row: 0, code: 'UNEXPECTED_ERROR', message: 'Unexpected error (HTTP 409)' }],
      });
    });

    it('undoImport throws the retry message and code of a 409 macrocycle-busy', async () => {
      mockFetch.mockResolvedValue(busy('undo'));
      await expect(makeClient().undoImport('5-3-1', 'b-1')).rejects.toMatchObject({
        name: 'ApiClientError',
        status: 409,
        code: 'macrocycle-busy',
        message: 'Your workouts are being saved. Try the undo again in a moment.',
      });
    });

    it('initializeMacrocycle throws a 409 import-in-progress rather than reading it as already initialized', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ code: 'import-in-progress', message: 'An import is changing your macrocycles.' }), { status: 409 }),
      );
      await expect(makeClient().initializeMacrocycle('5-3-1')).rejects.toMatchObject({ status: 409, code: 'import-in-progress' });
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ message: 'exists' }), { status: 409 }));
      await expect(makeClient().initializeMacrocycle('5-3-1')).resolves.toBeNull();
    });

    it('every request helper reports the response code: a failed workout read and delete carry it', async () => {
      const failure = () => new Response(JSON.stringify({ code: 'import-in-progress', message: 'busy' }), { status: 409 });
      mockFetch.mockResolvedValueOnce(failure()).mockResolvedValueOnce(failure());
      await expect(makeClient().fetchWorkout('5-3-1', 1)).rejects.toMatchObject({ code: 'import-in-progress', message: 'busy' });
      await expect(makeClient().deleteCurrentMacrocycle('5-3-1')).rejects.toMatchObject({ code: 'import-in-progress' });
    });

    it('undoImport keeps its generic message for other failures, with the status and code', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ message: 'boom', code: 'oops' }), { status: 500 }));
      await expect(makeClient().undoImport('5-3-1', 'b-1')).rejects.toMatchObject({
        name: 'ApiClientError',
        status: 500,
        code: 'oops',
        message: 'Undo import failed (HTTP 500)',
      });
    });
  });

  describe('smart import (previewImport / commitImport)', () => {
    const file = new File(['a,b\n1,2'], 'records.csv', { type: 'text/csv' });

    it('previewImport POSTs to mode=preview and returns the parsed preview', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ classification: {}, destination: 'training-maxes', preview: {}, errors: [] }),
          { status: 200 },
        ),
      );
      const client = makeClient();
      const result = await client.previewImport('5-3-1', file);
      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/programs/5-3-1/import?mode=preview');
      expect(init.method).toBe('POST');
      // FormData body must not carry a manual Content-Type.
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
      expect(result).toMatchObject({ destination: 'training-maxes' });
    });

    it('previewImport appends the destination override when supplied', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ errors: [] }), { status: 200 }));
      const client = makeClient();
      await client.previewImport('5-3-1', file, 'strength-goals');
      const [url] = lastCall();
      expect(url).toBe('http://api.test/programs/5-3-1/import?mode=preview&destination=strength-goals');
    });

    it('previewImport sends column overrides when supplied', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ errors: [] }), { status: 200 }));
      const client = makeClient();
      await client.previewImport('5-3-1', file, 'lift-records', { overrides: { Exercise: 'lift' } });
      const [url] = lastCall();
      expect(new URL(url).searchParams.get('overrides')).toBe('{"Exercise":"lift"}');
    });

    it('previewImport sends lift overrides in the body, as the commit does (#1169)', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ errors: [] }), { status: 200 }));
      const client = makeClient();
      await client.previewImport('5-3-1', file, 'strength-goals', { liftOverrides: { 1: 'custom-1' } });
      const [url, init] = lastCall();
      expect(new URL(url).searchParams.has('liftOverrides')).toBe(false);
      expect((init.body as FormData).get('liftOverrides')).toBe('{"1":"custom-1"}');
    });

    it('previewImport throws on a non-ok response', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 500 }));
      const client = makeClient();
      await expect(client.previewImport('5-3-1', file)).rejects.toThrow(
        'Import preview failed (HTTP 500)',
      );
    });

    it('commitImport returns ok:true with data on success', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ destination: 'training-maxes', created: 2, updated: 1, skipped: 0 }), {
          status: 200,
        }),
      );
      const client = makeClient();
      const result = await client.commitImport('5-3-1', file, 'training-maxes');
      const [url] = lastCall();
      expect(url).toBe('http://api.test/programs/5-3-1/import?mode=commit&destination=training-maxes');
      expect(result).toEqual({
        ok: true,
        data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0 },
      });
    });

    it('dryRunImport sends what commitImport sends, under mode=dry-run (#1123)', async () => {
      const counts = { destination: 'lift-records', created: 1, updated: 0, skipped: 0 };
      mockFetch.mockResolvedValue(new Response(JSON.stringify(counts), { status: 200 }));
      const client = makeClient();
      const result = await client.dryRunImport('5-3-1', file, 'lift-records', {
        excludeKeys: ['__row_2'],
        splitDest: true,
      });
      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/programs/5-3-1/import?mode=dry-run&destination=lift-records&splitDest=1');
      expect((init?.body as FormData).get('excludeKeys')).toBe('["__row_2"]');
      expect(result).toEqual({ ok: true, data: counts });
    });

    it('dryRunImport returns validation errors as data, like commitImport (#1123)', async () => {
      const errors = [{ row: 2, code: 'LIFT_EMPTY', message: 'Lift is empty' }];
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ errors }), { status: 400 }));
      const result = await makeClient().dryRunImport('5-3-1', file, 'lift-records');
      expect(result).toEqual({ ok: false, errors });
    });

    it('dryRunImport throws on a failure that is not about the file (#1123)', async () => {
      mockFetch.mockResolvedValue(new Response('upstream down', { status: 503 }));
      await expect(makeClient().dryRunImport('5-3-1', file, 'lift-records')).rejects.toMatchObject({
        name: 'ApiClientError',
        status: 503,
      });
    });

    it('dryRunImport throws the server message when a 400 carries no row errors (#1123)', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Could not parse file: bad row' }), { status: 400 }),
      );
      await expect(makeClient().dryRunImport('5-3-1', file, 'lift-records')).rejects.toThrow(
        'Could not parse file: bad row',
      );
    });

    it('commitImport sends excludeKeys and liftOverrides in the body, never the URL (#1121)', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ created: 0 }), { status: 200 }));
      const client = makeClient();
      await client.commitImport('5-3-1', file, 'lift-records', {
        // The comma matters: this list was once comma-joined, which split such a key.
        excludeKeys: ['1:1:20260101:Rows, Cable:1'],
        liftOverrides: { 2: 'bench-press' },
        overrides: { Exercise: 'lift' },
        splitDest: true,
      });
      const [url, init] = lastCall();
      const { searchParams } = new URL(url);
      expect(searchParams.has('excludeKeys')).toBe(false);
      expect(searchParams.has('liftOverrides')).toBe(false);
      expect(searchParams.get('overrides')).toBe('{"Exercise":"lift"}');
      expect(searchParams.get('splitDest')).toBe('1');
      const form = init.body as FormData;
      expect(JSON.parse(form.get('excludeKeys') as string)).toEqual(['1:1:20260101:Rows, Cable:1']);
      expect(JSON.parse(form.get('liftOverrides') as string)).toEqual({ '2': 'bench-press' });
      expect((form.get('file') as File).name).toBe('records.csv');
    });

    it('commitImport sends neither field when there is nothing to exclude or remap', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ created: 0 }), { status: 200 }));
      const client = makeClient();
      await client.commitImport('5-3-1', file, 'lift-records', { excludeKeys: [], liftOverrides: {} });
      const form = lastCall()[1].body as FormData;
      expect(form.has('excludeKeys')).toBe(false);
      expect(form.has('liftOverrides')).toBe(false);
    });

    it('commitImport returns ok:false with row errors on validation failure', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ row: 5, message: 'bad row' }] }), { status: 400 }),
      );
      const client = makeClient();
      const result = await client.commitImport('5-3-1', file, 'lift-records');
      expect(result).toEqual({ ok: false, errors: [{ row: 5, message: 'bad row' }] });
    });

    it('commitImport synthesizes a fallback error when the body is unparseable', async () => {
      mockFetch.mockResolvedValue(new Response('not json', { status: 500 }));
      const client = makeClient();
      const result = await client.commitImport('5-3-1', file, 'lift-records');
      expect(result).toEqual({
        ok: false,
        errors: [{ row: 0, code: 'UNEXPECTED_ERROR', message: 'Unexpected error (HTTP 500)' }],
      });
    });
  });

  describe('focus work (#1056)', () => {
    const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
    const NEW_BLOCK: CreateFocusBlockRequest = {
      area: 'Core',
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

    it.each([
      ['fetchFocusBlocks', (c: ReturnType<typeof makeClient>) => c.fetchFocusBlocks('2026-10-25'), 'GET', '/focus/blocks?today=2026-10-25'],
      ['fetchFocusBlockSummary', (c: ReturnType<typeof makeClient>) => c.fetchFocusBlockSummary('a b'), 'GET', '/focus/blocks/a%20b/summary'],
      ['fetchFocusSettings', (c: ReturnType<typeof makeClient>) => c.fetchFocusSettings(), 'GET', '/focus/settings'],
      ['fetchFocusPlan', (c: ReturnType<typeof makeClient>) => c.fetchFocusPlan('5-3-1', 4, '2026-10-25'), 'GET', '/programs/5-3-1/workouts/4/focus?today=2026-10-25'],
      ['fetchFocusDayState', (c: ReturnType<typeof makeClient>) => c.fetchFocusDayState('5-3-1', 4), 'GET', '/programs/5-3-1/workouts/4/focus-state'],
    ])('%s requests the right URL', async (_name, call, method, path) => {
      mockFetch.mockResolvedValue(ok());
      await call(makeClient());
      const [url, init] = lastCall();
      expect(url).toBe(`http://api.test${path}`);
      expect(init.method ?? 'GET').toBe(method);
    });

    it.each([
      ['createFocusBlock', (c: ReturnType<typeof makeClient>) => c.createFocusBlock(NEW_BLOCK, '2026-10-25'), 'POST', '/focus/blocks?today=2026-10-25', NEW_BLOCK],
      ['updateFocusBlock', (c: ReturnType<typeof makeClient>) => c.updateFocusBlock('b1', { area: 'Core' }, '2026-10-25'), 'PATCH', '/focus/blocks/b1?today=2026-10-25', { area: 'Core' }],
      ['reorderFocusBlocks', (c: ReturnType<typeof makeClient>) => c.reorderFocusBlocks(['b2', 'b1'], '2026-10-25'), 'PUT', '/focus/blocks/order?today=2026-10-25', { ids: ['b2', 'b1'] }],
      ['updateFocusSettings', (c: ReturnType<typeof makeClient>) => c.updateFocusSettings({ sets: 9, minutes: 20 }), 'PUT', '/focus/settings', { sets: 9, minutes: 20 }],
      ['saveFocusDayState', (c: ReturnType<typeof makeClient>) => c.saveFocusDayState('5-3-1', 4, { modes: {}, picks: {}, trims: {}, placement: 'after', order: null, dismissed: true }), 'PUT', '/programs/5-3-1/workouts/4/focus-state', { modes: {}, picks: {}, trims: {}, placement: 'after', order: null, dismissed: true }],
    ])('%s sends its body as JSON', async (_name, call, method, path, body) => {
      mockFetch.mockResolvedValue(ok());
      await call(makeClient());
      const [url, init] = lastCall();
      expect(url).toBe(`http://api.test${path}`);
      expect(init.method).toBe(method);
      expect(JSON.parse(init.body as string)).toEqual(body);
    });

    it('treats deleting an already-deleted focus block as success', async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 404 }));
      await expect(makeClient().deleteFocusBlock('gone')).resolves.toBeUndefined();
      const [url, init] = lastCall();
      expect(url).toBe('http://api.test/focus/blocks/gone');
      expect(init.method).toBe('DELETE');
    });
  });

  describe('the macrocycle id on page writes (#1198)', () => {
    const ID = { 'X-Macrocycle-Id': 'mc-a' };
    const ok = () => mockFetch.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
    const headersOf = () => lastCall()[1].headers as Record<string, string>;

    it('sends the id as a header on every page write that takes one', async () => {
      ok();
      const client = makeClient();
      const calls: [string, () => Promise<unknown>][] = [
        ['rescheduleWorkout', () => client.rescheduleWorkout('5-3-1', 1, 2, '2026-07-01', 'mc-a')],
        ['skipWorkout', () => client.skipWorkout('5-3-1', 1, 2, undefined, 'mc-a')],
        ['unskipWorkout', () => client.unskipWorkout('5-3-1', 1, 2, 'mc-a')],
        ['createLiftRecord', () => client.createLiftRecord(
          '5-3-1',
          { program: '5-3-1', macrocycleNum: 1, workoutNum: 2, date: '2026-07-01', lift: 'Squat', setNum: 1, weight: 225, reps: 5 },
          'mc-a',
        )],
        ['updateLiftRecord', () => client.updateLiftRecord('5-3-1', 'rec-1', {}, 'mc-a')],
        ['upsertLiftOverride', () => client.upsertLiftOverride('5-3-1', 1, 2, { action: 'add', lift: 'Dips' }, 'mc-a')],
        ['deleteLiftOverride', () => client.deleteLiftOverride('5-3-1', 1, 2, 'Dips', 'mc-a')],
        ['saveFocusDayState', () => client.saveFocusDayState('5-3-1', 2, emptyFocusDayState(), 'mc-a')],
      ];
      for (const [name, call] of calls) {
        await call();
        expect({ name, headers: headersOf() }).toEqual({ name, headers: expect.objectContaining(ID) });
      }
    });

    it('sends no id header when the caller has none', async () => {
      ok();
      await makeClient().rescheduleWorkout('5-3-1', 1, 2, '2026-07-01');
      expect(headersOf()).not.toHaveProperty('X-Macrocycle-Id');
    });

    it('carries the error code and body on the thrown error', async () => {
      const body = { statusCode: 409, code: 'macrocycle-moved', message: 'Moved', macrocycleNum: 2 };
      mockFetch.mockResolvedValue(new Response(JSON.stringify(body), { status: 409 }));
      await expect(makeClient().skipWorkout('5-3-1', 1, 2, undefined, 'mc-a')).rejects.toMatchObject({
        name: 'ApiClientError',
        status: 409,
        code: 'macrocycle-moved',
        body: expect.objectContaining({ macrocycleNum: 2 }),
      });
    });

    it('leaves the code undefined for an error body without one', async () => {
      mockFetch.mockResolvedValue(new Response('upstream down', { status: 503 }));
      await expect(makeClient().skipWorkout('5-3-1', 1, 2)).rejects.toMatchObject({ status: 503, code: undefined });
    });
  });
});
