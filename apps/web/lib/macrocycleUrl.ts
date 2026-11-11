import { ApiClientError } from '@lifting-logbook/api-client';

/**
 * Workout pages and a renumbered macrocycle (proposal decision 3, #1198). A macrocycle's
 * number, and so its URLs, can change; its stable id can't. Pages follow the number they read,
 * and a write the API refuses as `macrocycle-moved` reloads at the macrocycle's new number.
 */

/** `pathname` with its `/macrocycle/<n>` segment set to `macrocycleNum`. */
export function withMacrocycleNum(pathname: string, macrocycleNum: number): string {
  return pathname.replace(/^\/macrocycle\/[^/]+/, `/macrocycle/${macrocycleNum}`);
}

/**
 * Where a workout page whose URL says `urlNum` belongs, when the workout it read is
 * macrocycle `readNum`: null when they agree. The read always names the current macrocycle,
 * so following it once can't loop.
 */
export function movedWorkoutPath(pathname: string, urlNum: number, readNum: number): string | null {
  return urlNum === readNum ? null : withMacrocycleNum(pathname, readNum);
}

/** The macrocycle's new number when the API refused a write as `macrocycle-moved`, else null. */
export function movedMacrocycleNum(err: unknown): number | null {
  if (!(err instanceof ApiClientError) || err.code !== 'macrocycle-moved') return null;
  const num = err.body?.macrocycleNum;
  return typeof num === 'number' && Number.isInteger(num) ? num : null;
}

/**
 * The browser navigation a reload goes through. An object, so a test can replace `assign`
 * (jsdom can't navigate) while the real {@link followMovedMacrocycle} runs.
 */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/**
 * The query parameter a link carries the macrocycle's id in, so the page it opens can send it
 * without reading the workout again. A stale one is caught by the write (`macrocycle-moved`).
 */
export const MACROCYCLE_ID_PARAM = 'macrocycleId';

/** `href` with the macrocycle's id appended as {@link MACROCYCLE_ID_PARAM}, when there is one. */
export function withMacrocycleId(href: string, macrocycleId: string | undefined): string {
  if (!macrocycleId) return href;
  return `${href}${href.includes('?') ? '&' : '?'}${MACROCYCLE_ID_PARAM}=${encodeURIComponent(macrocycleId)}`;
}

/** Reloads the current page at the macrocycle's new number, keeping its query. */
export function reloadAtMacrocycle(macrocycleNum: number): void {
  browserNavigation.assign(withMacrocycleNum(window.location.pathname, macrocycleNum) + window.location.search);
}

/**
 * What to tell the lifter about a failed write: an import holding the lock (409
 * `import-in-progress`) is worth a retry in a moment, so it says so; anything else is
 * `fallback`.
 */
export function writeFailureMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError && err.code === 'import-in-progress'
    ? 'An import is updating your macrocycles. Try again in a moment.'
    : fallback;
}

/**
 * Handles a write the API refused because the page is stale: reloads at the new number and
 * returns true for `macrocycle-moved`. Any other error, including the other two 409 codes
 * (`import-in-progress`, a duplicate set), returns false for the caller to report.
 */
export function followMovedMacrocycle(err: unknown): boolean {
  const num = movedMacrocycleNum(err);
  if (num === null) return false;
  reloadAtMacrocycle(num);
  return true;
}
