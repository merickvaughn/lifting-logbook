import { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { parseLiftRecordId } from '@lifting-logbook/core';
import { MACROCYCLE_ID_HEADER, MacrocycleSummaryResponse } from '@lifting-logbook/types';

/**
 * The number a page write names, read the way its route reads it: from the URL, from the body of
 * `POST lift-records` (`macrocycleNum`) or `POST macrocycles` (`fromMacrocycleNum`), or from a
 * lift record's id. Undefined for a route that writes to the current macrocycle.
 */
function writtenNumber(program: string, path: string, body: unknown): number | undefined {
  const fromUrl = /\/macrocycles\/(\d+)\//.exec(path)?.[1];
  if (fromUrl !== undefined) return Number(fromUrl);
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (/\/lift-records$/.test(path) && typeof fields['macrocycleNum'] === 'number') return fields['macrocycleNum'];
  if (/\/macrocycles$/.test(path) && typeof fields['fromMacrocycleNum'] === 'number') return fields['fromMacrocycleNum'];
  const recordId = /\/lift-records\/([^/]+)$/.exec(path)?.[1];
  if (recordId !== undefined) return parseLiftRecordId(program, decodeURIComponent(recordId))?.macrocycleNum;
  return undefined;
}

/**
 * The macrocycle id header a page sends with a write (proposal decision 3, #1198), for HTTP
 * suites whose subject isn't the id itself: a write with none is a 400 since #1200.
 *
 * It reads `workouts/1` first, as a page loads its workout, which gives the current macrocycle a
 * row if it has none, then sends the listed id of the macrocycle the write names (the current
 * one for a route with no number). There's no header when `url` names no program, the program
 * can't be listed or has none, or a write with no number finds no current macrocycle, as before
 * initializing. A write naming a number the program's list lacks throws, since no page could
 * send an id for it: a test of that case sends its own header, such as {@link currentMacrocycleId}.
 * `macrocycle-id.e2e.spec.ts` tests the header itself.
 */
async function pageWriteHeaders(
  app: NestFastifyApplication,
  url: string,
  authorization: string,
  body?: unknown,
): Promise<Record<string, string>> {
  const [path = ''] = url.split('?');
  const program = /^\/programs\/([^/]+)\//.exec(path)?.[1];
  if (!program) return {};
  const listed = await listMacrocycles(app, program, authorization);
  if (!listed) return {};
  const num = writtenNumber(decodeURIComponent(program), path, body);
  const row = listed.find((m) => (num === undefined ? m.current : m.macrocycleNum === num));
  if (!row && num !== undefined && listed.length > 0) {
    throw new Error(`injectPage: ${program} has no macrocycle ${num} for a page to hold an id for; send the header yourself`);
  }
  return row ? { [MACROCYCLE_ID_HEADER]: row.id } : {};
}

/** Reads `workouts/1` as a page does, then `program`'s macrocycles, or null when it can't list them. */
async function listMacrocycles(
  app: NestFastifyApplication,
  program: string,
  authorization: string,
): Promise<MacrocycleSummaryResponse[] | null> {
  const server = app.getHttpAdapter().getInstance();
  await server.inject({ method: 'GET', url: `/programs/${program}/workouts/1`, headers: { authorization } });
  const list = await server.inject({ method: 'GET', url: `/programs/${program}/macrocycles`, headers: { authorization } });
  return list.statusCode === 200 ? (list.json() as MacrocycleSummaryResponse[]) : null;
}

/** The id a page holds for `program`'s current macrocycle (`program` URL-encoded). Throws when it has none. */
export async function currentMacrocycleId(app: NestFastifyApplication, program: string, authorization: string): Promise<string> {
  const row = (await listMacrocycles(app, program, authorization))?.find((m) => m.current);
  if (!row) throw new Error(`currentMacrocycleId: ${program} has no current macrocycle`);
  return row.id;
}

/**
 * Fastify's `inject`, with the macrocycle id header {@link pageWriteHeaders} gives added to a
 * write that has an authorization header and doesn't set the id itself. Reads pass through.
 */
export async function injectPage(app: NestFastifyApplication, options: InjectOptions): Promise<LightMyRequestResponse> {
  const server = app.getHttpAdapter().getInstance();
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = { ...(options.headers ?? {}) };
  const authorization = headers['authorization'];
  if (method === 'GET' || typeof authorization !== 'string' || MACROCYCLE_ID_HEADER in headers || !options.url) {
    return server.inject(options);
  }
  const url = typeof options.url === 'string' ? options.url : '';
  let body: unknown = options.payload;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      // Not JSON, such as a multipart upload; no write reads a number from it.
      body = undefined;
    }
  }
  return server.inject({ ...options, headers: { ...headers, ...(await pageWriteHeaders(app, url, authorization, body)) } });
}
