// Prevent Prisma's bundled dotenv from polluting the test environment.
//
// When @prisma/client is first imported, its runtime library loads apps/api/.env
// via a bundled dotenv, setting CLERK_SECRET_KEY and DATABASE_URL into process.env.
// This happens at module-evaluation time (during the import chain that starts when
// programs.e2e.spec.ts is loaded), AFTER this setupFiles script runs.
//
// Strategy:
//   1. Pre-set blocked keys to '' in the real process.env (so hasOwnProperty returns
//      true — Prisma's dotenv skips keys that are already "owned").
//   2. Wrap process.env in a Proxy whose set trap discards writes to blocked keys.
//      This is the fallback in case any path assigns directly without checking hasOwnProperty.
//
// Note: Object.defineProperty(process.env, key, {get, set}) does NOT work in
// Node.js 20 — it throws ERR_INVALID_OBJECT_DEFINE_PROPERTY. The Proxy approach
// is the only reliable mechanism.
//
// With CLERK_SECRET_KEY = '' (falsy):
//   - auth.module.ts: '' ? ClerkAuthProvider : DevAuthProvider → DevAuthProvider ✓
//   - auth.module.ts guard: '' === '' AND NODE_ENV !== 'test' → false → no throw ✓
// With DATABASE_URL = '' (falsy):
//   - describeOrSkip helper: !!'' → false → DB-only describe blocks skip ✓
// With DEV_USER_ID / DEV_USER_EMAIL = '':
//   - DevAuthProvider: uses the Bearer token value as user ID (expected by tests) ✓

// Pin the test process to UTC. Several date-sensitive paths touched by issue
// #884 (CSV date parsing, LiftRecord's YYYYMMDD natural key/id encoding) are
// only guaranteed correct when the parsing host's local time IS UTC — without
// this, a test asserting an exact date could pass or fail depending on the
// machine's timezone rather than on the code being correct, and CI (which
// already runs UTC) would never catch a host-timezone-dependent regression
// that a non-UTC contributor's machine could hit.
process.env.TZ = 'UTC';

const BLOCK = [
  'CLERK_SECRET_KEY',
  'DATABASE_URL',
  'SYSTEM_DATABASE_URL',
  'USER_DATA_DATABASE_URL',
  'DEV_USER_ID',
  'DEV_USER_EMAIL',
];

for (const key of BLOCK) {
  process.env[key] = '';
}

// Never start the OpenTelemetry SDK during tests. otel.ts autostarts on import
// unless OTEL_SDK_AUTOSTART === 'false'; importing it from a spec (e.g.
// otel.spec.ts, #487) would otherwise spin up exporters + a PeriodicExporting-
// MetricReader interval that keeps Jest from exiting cleanly. No test tracing is
// the policy — see ADR-021.
process.env.OTEL_SDK_AUTOSTART = 'false';

const originalEnv = process.env;
process.env = new Proxy(originalEnv, {
  set(target, key, value) {
    // Allow the DB E2E spec to restore DATABASE_URL from either sentinel
    // jest.global-setup.js sets (issue #646): LIFTING_TC_DATABASE_URL (the
    // restricted lifting_app role — the default) or LIFTING_TC_OWNER_DATABASE_URL
    // (the superuser/owner opt-in). Both are exact, fixed strings by the time any
    // worker's setupFiles script runs — global-setup sets them once in the parent
    // process before workers fork — so an exact match against either is sufficient;
    // no derived third URL is a legitimate write.
    if (
      String(key) === 'DATABASE_URL' &&
      value &&
      (value === target.LIFTING_TC_DATABASE_URL || value === target.LIFTING_TC_OWNER_DATABASE_URL)
    ) {
      target[key] = value;
      return true;
    }
    if (BLOCK.includes(String(key))) {
      return true; // discard — blocked keys are frozen at ''
    }
    target[key] = value;
    return true;
  },
});
