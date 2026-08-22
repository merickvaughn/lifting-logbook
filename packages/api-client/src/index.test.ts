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
      expect(url).toBe('http://api.test/programs/5-3-1/cycles/1/workouts/2/reschedule');
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
  });

  describe('nullable reads', () => {
    it('returns null on 404 instead of throwing', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 404 }));
      const client = makeClient();
      await expect(client.fetchCycleDashboard('5-3-1')).resolves.toBeNull();
    });

    it('returns the parsed body on 200', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ program: '5-3-1', cycleNum: 3 }), { status: 200 }),
      );
      const client = makeClient();
      await expect(client.fetchCycleDashboard('5-3-1')).resolves.toEqual({
        program: '5-3-1',
        cycleNum: 3,
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

  describe('conflict-tolerant POSTs (initializeCycle)', () => {
    it('returns null on 409 Conflict instead of throwing', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: 'A cycle for "rpt" already exists.' }), { status: 409 }),
      );
      const client = makeClient();
      await expect(client.initializeCycle('rpt')).resolves.toBeNull();
    });

    it('returns the parsed dashboard on 200', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ program: 'rpt', cycleNum: 1 }), { status: 200 }),
      );
      const client = makeClient();
      await expect(client.initializeCycle('rpt')).resolves.toMatchObject({ program: 'rpt', cycleNum: 1 });
    });

    it('throws on a non-409 error', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ message: 'server exploded' }), { status: 500 }),
      );
      const client = makeClient();
      await expect(client.initializeCycle('rpt')).rejects.toThrow('server exploded');
    });
  });

  describe('switchProgram', () => {
    it('sends a JSON body alongside the JSON content-type header (issue #665)', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ activeProgram: 'leangains', cycleNum: 1 }), { status: 200 }),
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
        new Response(JSON.stringify({ activeProgram: 'leangains', cycleNum: 3 }), { status: 200 }),
      );
      const client = makeClient();
      await expect(client.switchProgram('leangains')).resolves.toEqual({
        activeProgram: 'leangains',
        cycleNum: 3,
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
});
