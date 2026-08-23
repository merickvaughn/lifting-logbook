import 'server-only';

import { auth } from '@clerk/nextjs/server';
import { createApiClient } from '@lifting-logbook/api-client';
import { getGcpIdentityToken } from './gcp-identity-token';
import { CLERK_TOKEN_TIMEOUT_MS, withTimeout } from './with-timeout';

const API_URL = process.env.API_URL ?? 'http://localhost:3004';
const isCloudRun = API_URL.startsWith('https://');

// ---------------------------------------------------------------------------
// AUTH HEADER INVARIANT (server path) — read before changing this strategy.
//
// Server -> API requests cross Cloud Run IAM, which consumes the `Authorization`
// header for the GCP identity token. The Clerk JWT therefore travels in the custom
// `X-Clerk-Authorization` header (read by apps/api auth.guard.ts). Hand-building an
// `Authorization: Bearer <clerk-jwt>` header on this path will 403 behind Cloud Run IAM.
//
// This is the ONLY thing the server wrapper does differently from the browser one:
// every endpoint lives in @lifting-logbook/api-client; this module just supplies the
// strategy below. The client merges these headers with auth-wins precedence, so call
// sites cannot override them. The browser path uses a DIFFERENT scheme (plain
// Authorization) — see lib/client-api.ts. See CONTRIBUTING.md -> API auth headers.
// ---------------------------------------------------------------------------
async function getAuthHeaders(): Promise<Record<string, string>> {
  if (!isCloudRun) {
    const devToken = process.env.DEV_AUTH_TOKEN;
    return devToken ? { Authorization: `Bearer ${devToken}` } : {};
  }

  // Cloud Run IAM requires the identity token in Authorization; pass the Clerk JWT
  // in a custom header so the NestJS AuthGuard can read it without collision.
  // See infra/terraform/cloud-run.tf (web_invoker_on_api binding).
  // Both fetches are independent — run them in parallel.
  const [clerkToken, identityToken] = await Promise.all([
    // Bounded via withTimeout — Clerk's getToken() has no native AbortSignal/timeout
    // option of its own (unlike getGcpIdentityToken's fetch signal below), so this has to
    // be hand-rolled. See with-timeout.ts for the mechanism and CLERK_TOKEN_TIMEOUT_MS for
    // the shared bound; a hang here previously blocked getAuthHeaders() (and therefore the
    // fetch() it precedes) indefinitely, reproducing #922's stuck-row bug via Clerk (#933).
    withTimeout(
      (async (): Promise<string | null> => {
        try {
          const { getToken } = await auth();
          const token = await getToken();
          if (!token) {
            console.warn('[getAuthHeaders] No Clerk session token in Cloud Run — request will be unauthenticated');
          }
          return token;
        } catch (e) {
          console.error('[getAuthHeaders] Clerk token acquisition failed:', e);
          return null;
        }
      })(),
      CLERK_TOKEN_TIMEOUT_MS,
      null,
      () => console.warn('[getAuthHeaders] Clerk token acquisition timed out — proceeding unauthenticated'),
    ),
    getGcpIdentityToken(API_URL),
  ]);

  if (identityToken && clerkToken) {
    return {
      Authorization: `Bearer ${identityToken}`,
      'X-Clerk-Authorization': `Bearer ${clerkToken}`,
    };
  }
  if (identityToken) {
    // No Clerk session — passes Cloud Run IAM gate; NestJS returns 401 for protected endpoints
    return { Authorization: `Bearer ${identityToken}` };
  }
  if (clerkToken) {
    console.warn('[getAuthHeaders] GCP identity token unavailable — falling back to Clerk JWT in Authorization, expect Cloud Run IAM 403');
    return { Authorization: `Bearer ${clerkToken}` };
  }
  return {};
}

// Endpoints are defined once in @lifting-logbook/api-client. This module is a thin
// wrapper that binds them to the server auth strategy above and re-exports the
// subset used by Server Components / Server Actions.
export const {
  fetchCycleDashboard,
  createCycle,
  deleteCurrentCycle,
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchTrainingMaxHistory,
  updateTrainingMaxHistoryEntry,
  updateTrainingMaxes,
  fetchWorkout,
  fetchLiftRecords,
  createLiftRecord,
  updateLiftRecord,
  recordBodyWeight,
  fetchLatestBodyWeight,
  fetchStrengthGoals,
  upsertStrengthGoal,
  deleteStrengthGoal,
  fetchLiftCatalog,
  fetchLiftMetadata,
  fetchCustomLifts,
  fetchUserSettings,
  updateUserSettings,
  switchProgram,
  fetchCustomPrograms,
  fetchCustomProgram,
  createCustomProgram,
  updateCustomProgram,
  deleteCustomProgram,
} = createApiClient({ baseUrl: API_URL, getAuthHeaders });
