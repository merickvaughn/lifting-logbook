/**
 * Races `promise` against a `ms` timer, resolving to `fallback` if the timer wins.
 *
 * Exists for async calls that don't accept their own AbortSignal/timeout option — e.g.
 * Clerk's `getToken()` (see lib/api.ts and lib/client-api.ts), where `fetch`'s native
 * `signal: AbortSignal.timeout(ms)` isn't available and the bound has to be hand-rolled.
 * Two correctness details this handles once so callers don't have to re-derive them (#933):
 *
 *   - the timer is always cleared, whichever side wins, so a settled race never leaves
 *     a dangling setTimeout handle;
 *   - `promise` is never abandoned — a rejection handler is attached up front, so a
 *     "lost" race's later rejection resolves to `fallback` instead of surfacing as an
 *     unhandled promise rejection. `promise` may still do wasted work in the background;
 *     that's acceptable for a token fetch — it just can't throw unhandled.
 *
 * `onTimeout` fires only when the timer wins (not on a plain rejection), so a caller can
 * log the distinct "this hung" case without complicating the return type. `onTimeout` is
 * itself best-effort — a throwing callback (e.g. a logging call in an unusual environment)
 * must never break the one guarantee this function exists to provide, so its exception is
 * swallowed rather than allowed to pre-empt `resolve(fallback)`.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // best-effort diagnostic callback — must never affect whether/how the race settles
      }
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

// Shared bound for Clerk token acquisition — both lib/api.ts (server) and lib/client-api.ts
// (browser) call withTimeout with this value rather than each declaring their own copy, so
// the two paths can't silently drift out of sync. Mirrors getGcpIdentityToken's existing 2s
// bound for this same kind of fast auxiliary auth call (#933).
export const CLERK_TOKEN_TIMEOUT_MS = 2000;
