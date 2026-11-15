import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// The value each dynamic segment takes when warming a route, chosen from the records
// the mock API serves by default (e2e/mock-api.mjs). A page that answers 404 for its
// value (/non-cycle/1: the mock adds that workout only when a spec asks) is compiled
// all the same, which is all the warmup needs.
export const SEGMENT_VALUES: Record<string, string> = {
  macrocycleNum: '1',
  workoutNum: '1',
  lift: 'squat',
};

// Pages the local suite never serves. /sign-in mounts Clerk's hosted sign-in, which the
// e2e config's placeholder keys can't load, and DEV_AUTH_TOKEN bypasses it.
export const SKIPPED_ROUTES = new Set(['/sign-in']);

/**
 * Lists one URL per `page.tsx` under `appDir`, the App Router's page convention: route
 * groups `(name)` drop out of the path, dynamic segments `[name]` take their value from
 * SEGMENT_VALUES, and an optional catch-all `[[...name]]` matches the bare path.
 *
 * Throws on a dynamic segment with no value, so a new page can't silently go unwarmed.
 */
export function listWarmupRoutes(appDir: string): string[] {
  const routes: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === 'page.tsx') {
        const route = '/' + segments.join('/');
        if (!SKIPPED_ROUTES.has(route)) routes.push(route);
      } else if (entry.isDirectory()) {
        walk(join(dir, entry.name), [...segments, ...urlSegment(entry.name, join(dir, entry.name))]);
      }
    }
  };
  walk(appDir, []);
  return routes.sort();
}

function urlSegment(name: string, dir: string): string[] {
  if (/^\(.+\)$/.test(name)) return [];
  if (/^\[\[\.\.\..+\]\]$/.test(name)) return [];
  const dynamic = /^\[(.+)\]$/.exec(name);
  if (!dynamic) return [name];
  const value = SEGMENT_VALUES[dynamic[1]];
  if (value === undefined) {
    throw new Error(
      `e2e warmup: no value for dynamic segment [${dynamic[1]}] (${dir}). ` +
        'Add one to SEGMENT_VALUES in apps/web/e2e/warmup-routes.ts.',
    );
  }
  return [value];
}
