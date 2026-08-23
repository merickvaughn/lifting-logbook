// Write operations called directly from the browser (Client Components).
// Auth token is provided by ClerkApiInitializer via setAuthTokenGetter.

import { createApiClient } from '@lifting-logbook/api-client';
import { getClientPublicConfig } from './public-config';
import { withTimeout } from './with-timeout';

// Bounds the Clerk token call so a hang doesn't block getClientAuthHeaders() (and
// therefore the fetch() it precedes) indefinitely — mirrors the server path's own
// bound in lib/api.ts. Clerk's getToken() accepts no AbortSignal/timeout option of its
// own, so this has to be hand-rolled via withTimeout rather than passed as a signal (#933).
const CLERK_TOKEN_TIMEOUT_MS = 2000;

// Base URL and dev token are resolved LAZILY (per request) from the runtime-injected
// window.__PUBLIC_CONFIG__ rather than read at module-eval time. The values are no longer
// baked into the bundle at build time (#396 / ADR-028); the inline <head> script populates
// the window global before this module evaluates or any fetch fires.
function getApiUrl(): string {
  return getClientPublicConfig().apiUrl;
}

// Dev-auth bearer token is only ever present in dev/Playwright (never on Cloud Run, where
// the apiUrl is https://). Resolved per call so it tracks the runtime config.
function getDevToken(): string | undefined {
  const { apiUrl, devAuthToken } = getClientPublicConfig();
  const isCloudRun = apiUrl.startsWith('https://');
  return !isCloudRun ? devAuthToken : undefined;
}

type TokenGetter = () => Promise<string | null>;
let _getToken: TokenGetter | null = null;

export function setAuthTokenGetter(fn: TokenGetter): void {
  _getToken = fn;
}

// ---------------------------------------------------------------------------
// AUTH HEADER INVARIANT (browser path) — read before changing this strategy.
//
// Browser -> API calls send the Clerk JWT in `Authorization` (there is no Cloud Run
// IAM hop on the client path, so no header collision). This is the ONLY thing the
// browser wrapper does differently from the server one: every endpoint lives in
// @lifting-logbook/api-client; this module just supplies the strategy below. The
// SERVER path uses a different header (X-Clerk-Authorization) — see lib/api.ts.
// See CONTRIBUTING.md -> API auth headers.
// ---------------------------------------------------------------------------
async function getClientAuthHeaders(): Promise<Record<string, string>> {
  const devToken = getDevToken();
  if (devToken) return { Authorization: `Bearer ${devToken}` };
  if (_getToken) {
    // Snapshot to a local const: _getToken is a mutable module-level `let`, so a
    // closure referencing it directly loses TS's non-null narrowing from the check above.
    const getToken = _getToken;
    const token = await withTimeout(
      (async (): Promise<string | null> => {
        try {
          return await getToken();
        } catch (e) {
          console.error('[getClientAuthHeaders] Clerk token acquisition failed:', e);
          return null;
        }
      })(),
      CLERK_TOKEN_TIMEOUT_MS,
      null,
      () => console.warn('[getClientAuthHeaders] Clerk token acquisition timed out — proceeding unauthenticated'),
    );
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return {};
}

// Endpoints are defined once in @lifting-logbook/api-client. This module is a thin
// wrapper that binds them to the browser auth strategy above and re-exports the
// subset of write operations invoked from Client Components.
export const {
  createLiftRecord,
  updateLiftRecord,
  rescheduleWorkout,
  skipWorkout,
  unskipWorkout,
  recordBodyWeight,
  upsertLiftOverride,
  patchLiftMetadata,
  deleteLiftOverride,
  importLiftRecords,
  previewImport,
  commitImport,
  undoImport,
  createCustomLift,
  // Read, not just a write — but the 409 self-heal path needs to refetch the
  // live custom-lift list client-side (a stale/absent local copy otherwise
  // dead-ends the user with no way to recover short of a page reload; #911).
  fetchCustomLifts,
} = createApiClient({ baseUrl: getApiUrl, getAuthHeaders: getClientAuthHeaders });
