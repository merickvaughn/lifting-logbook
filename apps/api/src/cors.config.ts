/**
 * CORS origin allowlist for the API.
 *
 * Browser → API calls are cross-origin: per ADR-028 the web app (on its own Cloud Run URL or
 * custom domain) calls the API's external URL directly from the browser, so the API must echo
 * `Access-Control-Allow-Origin` for the web app's origins or the browser blocks every
 * client-side write. Cloud Run adds no CORS headers of its own, and making the service publicly
 * invokable (ADR-032) only removes the IAM 403 on the preflight — the application still has to
 * answer that preflight with the right CORS headers. This module produces the allowlist that
 * `main.ts` feeds to `app.enableCors()`.
 *
 * This is an allowlist, not an origin reflector. The real authorization gate is the Clerk JWT
 * the browser sends in the `Authorization` header (see `auth.guard.ts` / ADR-032); CORS only
 * decides which web origins may issue browser calls to the API at all.
 */

import { MACROCYCLE_ID_HEADER } from '@lifting-logbook/types';

/**
 * Deployed web origins, allowed in every environment.
 *
 * Each Cloud Run web service is reachable at BOTH address formats Cloud Run assigns, and both
 * are live simultaneously, so both must be listed:
 *   - legacy hash format:    `https://lifting-logbook-<env>-web-<hash>-uc.a.run.app`
 *   - project-number format: `https://lifting-logbook-<env>-web-<projectNumber>.us-central1.run.app`
 *
 * `status.url` reports only the hash format, but the staging integration suite (for example)
 * loads the app from the project-number URL — listing only one silently breaks real traffic.
 * Both prod and staging origins live in this single shared list; cross-environment calls are
 * still gated by each environment's own Clerk keys at the auth layer, so sharing the list is
 * safe and keeps the config to one place.
 *
 * Exact URLs verified live 2026-07-09 via:
 *   gcloud run services describe lifting-logbook-<env>-web --region=us-central1 \
 *     --project=lifting-logbook-<prod|staging> --format='value(status.url)'
 *   gcloud projects describe lifting-logbook-<prod|staging> --format='value(projectNumber)'
 * If a service is ever recreated (new hash) use the `CORS_ALLOWED_ORIGINS` override below until
 * this list is updated.
 */
export const DEFAULT_CORS_ORIGINS: readonly string[] = [
  // Prod custom domain (Cloud Run domain mappings: apex + www).
  'https://liftinglogbook.com',
  'https://www.liftinglogbook.com',
  // Prod web — both Cloud Run address formats.
  'https://lifting-logbook-prod-web-fvijrjuzmq-uc.a.run.app',
  'https://lifting-logbook-prod-web-508649171914.us-central1.run.app',
  // Staging web — both Cloud Run address formats.
  'https://lifting-logbook-stg-web-mn3pkptvma-uc.a.run.app',
  'https://lifting-logbook-stg-web-910635705567.us-central1.run.app',
];

/**
 * Local Next.js dev-server origins. Added only OUTSIDE a deployed runtime: deploy.yml sets
 * `NODE_ENV` to `production` (prod) or `staging` (staging), so these never enter a deployed
 * allowlist; locally `NODE_ENV` is unset/`development` and they apply.
 */
export const LOCAL_DEV_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

/** `NODE_ENV` values used by deployed runtimes (deploy.yml). */
const DEPLOYED_NODE_ENVS: ReadonlySet<string> = new Set(['production', 'staging']);

/**
 * Resolve the origin allowlist for `app.enableCors({ origin })`.
 *
 * - If `CORS_ALLOWED_ORIGINS` is set (comma-separated), it FULLY REPLACES the built-in list —
 *   an ops escape hatch to adjust origins without a code change. Entries are trimmed; blanks
 *   are dropped.
 * - Otherwise {@link DEFAULT_CORS_ORIGINS} is used, plus {@link LOCAL_DEV_ORIGINS} when not
 *   running in a deployed environment.
 *
 * Env values are parameters (defaulting to `process.env`) so the function is pure and
 * unit-testable without mutating `process.env` or bootstrapping Nest.
 */
export function resolveCorsOrigins(
  rawAllowedOrigins: string | undefined = process.env.CORS_ALLOWED_ORIGINS,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string[] {
  if (rawAllowedOrigins && rawAllowedOrigins.trim().length > 0) {
    return rawAllowedOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  const origins: string[] = [...DEFAULT_CORS_ORIGINS];
  if (!DEPLOYED_NODE_ENVS.has(nodeEnv ?? '')) {
    origins.push(...LOCAL_DEV_ORIGINS);
  }
  return origins;
}

/**
 * The options `main.ts` passes to `app.enableCors()`, shared with `cors.preflight.spec.ts` so
 * the spec tests the real config. A request header the browser sends that isn't in
 * `allowedHeaders` fails its preflight, and the browser blocks the request outright (#766).
 */
export function corsOptions(origin: string[] = resolveCorsOrigins()) {
  return {
    origin,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // Workout pages send their macrocycle's stable id with each write (#1198).
    allowedHeaders: ['Authorization', 'Content-Type', MACROCYCLE_ID_HEADER],
    maxAge: 3600,
  };
}
