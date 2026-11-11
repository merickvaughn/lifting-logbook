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

/** The codes whose API message is written for the lifter, so the page shows it as is. */
const LIFTER_MESSAGE_CODES = new Set(['import-in-progress', 'macrocycle-not-current', 'macrocycle-not-found']);

/**
 * What to tell the lifter about a failed write: the API's own message for an import holding
 * the lock (409 `import-in-progress`), a write to a macrocycle that is no longer current (409
 * `macrocycle-not-current`), or a page whose macrocycle no longer exists (404
 * `macrocycle-not-found`, as after deleting and starting again). The last two ask for a reload, which a retry can't replace, and name no
 * internal id. Anything else is `fallback`.
 */
export function writeFailureMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError && err.code !== undefined && LIFTER_MESSAGE_CODES.has(err.code) && err.message
    ? err.message
    : fallback;
}

/**
 * Handles a write the API refused because the page is stale, and returns true: reloads at the
 * new number for `macrocycle-moved`, and reloads the page as it is for a 400
 * `macrocycle-id-required`, which a page loaded before it read the macrocycle's id gets
 * (#1200); the reload reads it. Any other error, including the other two 409 codes
 * (`import-in-progress`, a duplicate set), returns false for the caller to report.
 */
export function followMovedMacrocycle(err: unknown): boolean {
  if (err instanceof ApiClientError && err.code === 'macrocycle-id-required') {
    browserNavigation.assign(window.location.pathname + window.location.search);
    return true;
  }
  const num = movedMacrocycleNum(err);
  if (num === null) return false;
  reloadAtMacrocycle(num);
  return true;
}
