// Jest globalSetup — provisions a Postgres instance for the DB E2E suite.
//
// Three paths:
//   1. CI (or any env that already exports DATABASE_URL): passthrough — re-expose
//      the existing URL via LIFTING_TC_DATABASE_URL so the spec can pick it up
//      without bypassing the env-isolation Proxy in jest.env.setup.js.
//   2. Explicit local opt-out (LIFTING_SKIP_DB_E2E=1): skip provisioning entirely;
//      the DB E2E spec's describeOrSkip will leave its blocks pending. Contract:
//      this escape hatch is only valid when the diff under test touches no DB
//      code (prisma schema, migrations, repositories). See issue #394.
//   3. Local: start an ephemeral postgres:16-alpine container via Testcontainers
//      (matches CI image), run `prisma migrate deploy` against it, and stash the
//      container handle on globalThis for teardown. Two distinct failure
//      messages so the headline matches reality (see Error Message Diligence
//      in global CLAUDE.md): `container.start()` failures throw
//      buildDockerUnavailableMessage (daemon unreachable, image pull, etc.);
//      `prisma migrate deploy` failures throw buildMigrationFailedMessage
//      (schema drift, SQL error, timeout — Docker is fine).
//
// In paths 1 and 3, once the database is confirmed migrated (so the `lifting_app`
// role from the enable_rls migration exists), this file also provisions that
// role's login password and exposes TWO connection strings (issue #646):
//   - LIFTING_TC_DATABASE_URL: the restricted `lifting_app` role. This is the
//     DEFAULT every DB E2E spec should use — it's the same non-superuser role
//     the production app runs as, so Row-Level Security is actually enforced.
//     Postgres superusers bypass RLS entirely regardless of policy correctness,
//     which is exactly how issue #644 (RlsInterceptor silently never setting the
//     RLS GUC) went undetected for 3+ weeks — every DB E2E suite ran as superuser.
//   - LIFTING_TC_OWNER_DATABASE_URL: the bootstrap superuser/owner connection,
//     kept available as an explicit, named opt-in for suites that genuinely need
//     to bypass RLS (seeding/cleanup across many synthetic users, or asserting on
//     RLS metadata itself). Only read this sentinel with a comment explaining why
//     the suite needs to bypass RLS.
// buildRoleProvisioningFailedMessage covers failures in that provisioning step —
// by that point Docker and migrations are both known-good, so the failure is
// specific to the ALTER ROLE statement itself.
//
// In paths 1 and 3 it then clones the migrated database once per Jest worker, and
// jest.env.setup.js points each worker's two connection strings at its own copy, so no
// two suites share a database (#1510, jest.worker-db.js).
//
// In paths 1 and 3 the spec reads LIFTING_TC_DATABASE_URL / LIFTING_TC_OWNER_DATABASE_URL
// (not DATABASE_URL) because jest.env.setup.js force-blanks DATABASE_URL in every
// worker to keep the in-memory e2e suite wiring InMemoryRepositoryFactory. The DB
// E2E spec restores DATABASE_URL from one of the two sentinels inside its own
// beforeAll; jest.env.setup.js allows exactly those two specific writes through
// its Proxy.

const path = require('path');
const { execSync } = require('child_process');
const { createWorkerDatabases } = require('./jest.worker-db');

// Pinned to a digest so local and CI runs are byte-identical. Keep this in sync
// with .github/workflows/ci.yml's postgres service image. To update: pull the
// latest postgres:16-alpine, capture its digest, and update both call sites.
const POSTGRES_IMAGE = 'postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229';
const MIGRATION_TIMEOUT_MS = 120_000;

// The restricted runtime role created (passwordless) by the enable_rls migration.
// Test-only password — never used outside an ephemeral Testcontainers instance or
// CI's throwaway service container.
const APP_ROLE = 'lifting_app';
const APP_ROLE_PASSWORD = 'lifting_app';

// Keep recovery copy in sync with docs/testing/e2e-coverage.md ("Running locally
// when Docker is unavailable") and the CLAUDE.md Testing prerequisites bullet.
// If you edit option text here, update both docs in the same PR.
function buildDockerUnavailableMessage(underlying) {
  return [
    '[jest.global-setup] Cannot start Postgres via Testcontainers — Docker appears unreachable.',
    '',
    'Recovery options:',
    '  1. Fix Docker Desktop (see issue #394 for the WSL distro reset procedure).',
    '  2. Set DATABASE_URL=postgresql://lifting:lifting@localhost:5433/lifting_test',
    '     after `docker-compose -f docker-compose.test.yml up -d`.',
    '  3. If your change does NOT touch apps/api/prisma or any DB repository,',
    '     set LIFTING_SKIP_DB_E2E=1 to skip the DB suite for this run.',
    '',
    `Underlying error: ${underlying && underlying.message ? underlying.message : String(underlying)}`,
  ].join('\n');
}

// Distinct from buildDockerUnavailableMessage: by the time we hit this path,
// the container has already started successfully, so the failure is in
// `prisma migrate deploy` itself — schema drift, SQL error, Prisma version
// mismatch, or migration timeout — NOT Docker reachability. Reporting "Docker
// appears unreachable" here would misdirect the contributor (see global
// CLAUDE.md → Error Message Diligence; lifting-logbook PR #423 review).
function buildMigrationFailedMessage(underlying) {
  return [
    '[jest.global-setup] `prisma migrate deploy` failed against the started Testcontainers Postgres.',
    '',
    'Docker IS reachable — the container started cleanly. The failure is in the migration step itself.',
    '',
    'Likely causes:',
    '  1. Schema drift between apps/api/prisma/schema.prisma and the migrations/ history.',
    '  2. A SQL error in a new migration (run with DEBUG=prisma:* for the full trace).',
    '  3. Prisma CLI / engine version mismatch (rare; rerun `npm install` and retry).',
    '  4. Migration timeout (current limit: ' + (MIGRATION_TIMEOUT_MS / 1000) + 's — increase MIGRATION_TIMEOUT_MS if migrations have grown).',
    '',
    `Underlying error: ${underlying && underlying.message ? underlying.message : String(underlying)}`,
  ].join('\n');
}

// Distinct from the two messages above: by the time this fires, Docker is
// reachable AND migrations have already succeeded (this only runs after a
// successful CI passthrough or a successful local migrate-deploy), so the
// failure is specific to provisioning the lifting_app role's login password.
function buildRoleProvisioningFailedMessage(underlying) {
  return [
    '[jest.global-setup] Failed to provision the `lifting_app` role\'s login password.',
    '',
    'Docker is reachable and migrations succeeded — the failure is specific to this step.',
    '',
    'Likely causes:',
    '  1. The enable_rls migration (20260611000000_enable_rls) has not actually run,',
    '     so the `lifting_app` role does not exist yet — check the migration history.',
    '  2. The owner/superuser connection used here lacks privilege to ALTER ROLE —',
    '     should not happen against the bootstrap superuser Testcontainers/CI creates.',
    '  3. A network or auth issue reaching the database specific to this connection.',
    '',
    `Underlying error: ${underlying && underlying.message ? underlying.message : String(underlying)}`,
  ].join('\n');
}

// Clones ownerUrl with the lifting_app role's credentials substituted in — same
// host/port/database, only the role differs.
function appRoleUrl(ownerUrl) {
  const u = new URL(ownerUrl);
  u.username = APP_ROLE;
  u.password = APP_ROLE_PASSWORD;
  return u.toString();
}

// Bounds the ALTER ROLE call the same way MIGRATION_TIMEOUT_MS bounds the migrate-deploy
// step above: without this, a connectivity loss in the (narrow) window between a successful
// migration and this step would hang globalSetup indefinitely instead of failing fast with
// buildRoleProvisioningFailedMessage. Does not abort the underlying query directly (Prisma has
// no query-cancellation API) — the subsequent $disconnect() in provisionAppRolePassword's
// `finally` forces the connection closed, which is sufficient to unblock the process.
const ROLE_PROVISIONING_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Sets a known login password on the lifting_app role (created passwordless by the
// enable_rls migration) using the owner/superuser connection, which alone has
// privilege to ALTER ROLE. Idempotent — safe to call on every run.
async function provisionAppRolePassword(ownerUrl) {
  const { PrismaClient } = require('@prisma/client');
  const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  try {
    await withTimeout(
      owner.$executeRawUnsafe(
        `ALTER ROLE "${APP_ROLE}" WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`,
      ),
      ROLE_PROVISIONING_TIMEOUT_MS,
      'lifting_app role provisioning',
    );
  } finally {
    await owner.$disconnect().catch(() => {});
  }
}

// Truthy variants the opt-out accepts. Anything else that is set-but-not-listed
// triggers a near-miss warning so a typoed value doesn't silently fall through
// to the hard-fail path.
const SKIP_DB_E2E_TRUTHY = new Set(['1', 'true', 'yes']);

module.exports = async function globalSetup(globalConfig) {
  if (process.env.DATABASE_URL) {
    const ownerUrl = process.env.DATABASE_URL;
    try {
      await provisionAppRolePassword(ownerUrl);
    } catch (err) {
      throw new Error(buildRoleProvisioningFailedMessage(err));
    }
    await createWorkerDatabases(ownerUrl, globalConfig.maxWorkers);
    process.env.LIFTING_TC_OWNER_DATABASE_URL = ownerUrl;
    process.env.LIFTING_TC_DATABASE_URL = appRoleUrl(ownerUrl);
    // Clear DATABASE_URL so worker setupFiles' BLOCK list takes effect uniformly.
    // The spec restores it from one of the two sentinels above in beforeAll.
    delete process.env.DATABASE_URL;
    console.log(
      '[jest.global-setup] CI passthrough — provisioned lifting_app; it is now the default DB E2E connection.',
    );
    return;
  }

  const skipRaw = process.env.LIFTING_SKIP_DB_E2E;
  if (skipRaw !== undefined && skipRaw !== '') {
    if (SKIP_DB_E2E_TRUTHY.has(skipRaw.toLowerCase())) {
      console.warn(
        `[jest.global-setup] LIFTING_SKIP_DB_E2E=${skipRaw} — skipping DB E2E provisioning. ` +
          'DB-touching changes will not be locally verified. See issue #394.',
      );
      // Intentionally do not set LIFTING_TC_DATABASE_URL — the spec's
      // describeOrSkip will leave its blocks pending.
      return;
    }
    // Set but unrecognized — almost always a typo (e.g. "on", "skip", "Y").
    // Warn loudly so the contributor sees their value was ignored before we
    // proceed into the hard-fail path.
    console.warn(
      `[jest.global-setup] LIFTING_SKIP_DB_E2E="${skipRaw}" is not a recognized truthy value ` +
        `(accepted: ${[...SKIP_DB_E2E_TRUTHY].join(', ')}). Treating as unset — falling through ` +
        'to Testcontainers provisioning.',
    );
  }

  const { PostgreSqlContainer } = require('@testcontainers/postgresql');
  console.log(`[jest.global-setup] Starting ${POSTGRES_IMAGE} via Testcontainers...`);

  let container;
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('lifting_test')
      .withUsername('lifting')
      .withPassword('lifting')
      .start();
  } catch (err) {
    // Container.start() failed before we could stash a handle — most commonly
    // because the Docker daemon is unreachable. Surface the actionable message
    // so the failure is self-explanatory.
    throw new Error(buildDockerUnavailableMessage(err));
  }

  // Stash the handle before running migrations so globalTeardown can stop the
  // container even if migration fails (otherwise the started container would
  // leak — Ryuk cleanup is not guaranteed on every Docker Desktop config).
  globalThis.__LL_PG_CONTAINER__ = container;

  const url = container.getConnectionUri();
  const schemaPath = path.join(__dirname, 'prisma', 'schema.prisma');

  console.log('[jest.global-setup] Running prisma migrate deploy...');
  try {
    execSync(`npx prisma migrate deploy --schema=${schemaPath}`, {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'inherit',
      timeout: MIGRATION_TIMEOUT_MS,
    });
  } catch (err) {
    await container.stop().catch(() => {});
    globalThis.__LL_PG_CONTAINER__ = undefined;
    throw new Error(buildMigrationFailedMessage(err));
  }

  try {
    await provisionAppRolePassword(url);
  } catch (err) {
    // Mirror the migrate-failure branch above: stop the container and clear its
    // handle BEFORE throwing, so a role-provisioning failure can't leak it.
    await container.stop().catch(() => {});
    globalThis.__LL_PG_CONTAINER__ = undefined;
    throw new Error(buildRoleProvisioningFailedMessage(err));
  }

  try {
    await createWorkerDatabases(url, globalConfig.maxWorkers);
  } catch (err) {
    await container.stop().catch(() => {});
    globalThis.__LL_PG_CONTAINER__ = undefined;
    throw err;
  }

  process.env.LIFTING_TC_OWNER_DATABASE_URL = url;
  process.env.LIFTING_TC_DATABASE_URL = appRoleUrl(url);
  console.log(
    '[jest.global-setup] Postgres testcontainer ready — lifting_app is the default DB E2E connection.',
  );
};
