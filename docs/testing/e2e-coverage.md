# E2E Test Coverage

This document maps every critical user flow to its test coverage across the API layer (in-memory adapter and DB/Prisma adapter) and the frontend layer. Updated whenever new test files are added.

## Critical User Flows

| Flow | API (in-mem) | API (DB) | Frontend |
|---|---|---|---|
| Log a workout (lift records) | ✅ | ✅ | ✅ |
| Onboarding — initialize first cycle | ❌ | ✅ | ✅ |
| Advance a cycle | ✅ | ✅ | ❌ |
| Recalculate training maxes | ✅ | ✅ | ❌ |
| Reschedule a workout | ✅ | ✅ | ✅ (staging only — see `apps/web/e2e/staging.spec.ts`) |
| Manage lifts (overrides) | ✅ | ✅ | ❌ |
| Training max history / mark PR | ✅ | ✅ | ✅ |
| Strength goals | ✅ | ✅ | ✅ |
| Import lift records (CSV) | ❌ | ✅ | ❌ |
| Body weight logging | ✅ | ✅† | ❌ |
| History page — lift records + TM history together | ✅ each | ✅ | ✅ |
| User settings (`GET`/`PATCH /users/me/settings`) | ✅ | ✅ | ❌ |
| Custom programs (`GET`/`POST /programs/custom`) | N/A‡ | ✅ | ❌ |
| Switch program (`POST /programs/:p/switch`) | ✅ | ✅ | ✅ |

**†** Body weight has no Prisma adapter. `BODY_WEIGHT_REPOSITORY` is always wired to `InMemoryBodyWeightRepository` — even when `DATABASE_URL` is set. The DB-spec test exercises the HTTP contract but cannot make DB-level persistence assertions.

**‡** Custom programs are backed exclusively by Prisma (no in-memory variant exists for `CustomProgramsRepository` — see `docs/domain-model.md` D17, still open). User settings and switch program got their in-memory coverage in #1029/#1030.

## Test Files

| File | What it covers |
|---|---|
| `apps/api/src/programs/programs.e2e.spec.ts` | Full API surface via in-memory adapters. Runs on every `npm test`. |
| `apps/api/src/user-settings/user-settings.e2e.spec.ts` | `GET`/`PATCH /users/me/settings` via in-memory adapters (issue #1029). Runs on every `npm test`. |
| `apps/api/src/programs/programs.db.e2e.spec.ts` | Full API surface via Prisma adapters. Postgres is auto-provisioned by Jest globalSetup (Testcontainers locally; service container in CI). HTTP requests run through the restricted `lifting_app` role (RLS-enforced) by default; direct DB seeding/cleanup and cross-user fixture setup use the owner/superuser connection via `LIFTING_TC_OWNER_DATABASE_URL`. Runs on every `npm test -w @lifting-logbook/api` when Docker is available. |
| `apps/api/src/adapters/prisma/rls.db.e2e.spec.ts` | Row-Level Security enforcement and request-wiring tests (issues #511, #644). Connects as `lifting_app` for policy-enforcement assertions and full-app-boot HTTP tests; uses the owner connection only for cross-user seeding/cleanup and RLS-independent metadata checks against `pg_policy`/`pg_roles`. |
| `apps/api/src/observability/otel.e2e.spec.ts` | OTel + nestjs-pino trace correlation smoke test. |

## Frontend E2E Tests

Playwright smoke tests live in `apps/web/e2e/smoke.spec.ts`. They run against a lightweight
mock API server (`apps/web/e2e/mock-api.mjs`) that Playwright starts alongside the Next.js dev
server. No real database or running API is required.

**Architecture note:** Next.js server components make API calls server-side, so `page.route()`
cannot intercept them. The mock server handles both server-side (Next.js → API) and browser-side
(`client-api.ts` → API) fetch calls by listening on the same port (3004) that both consumers target.

### Running locally

```bash
# Install browsers once
npx playwright install chromium --with-deps

# Run tests (starts mock API + Next.js dev server automatically)
npm run test:e2e -w @lifting-logbook/web

# Headed mode for debugging
npx playwright test --headed --project=chromium
```

### CI

The `e2e` job in `.github/workflows/ci.yml` runs after `lint-and-test` passes. Failures upload an
HTML report as a GitHub Actions artifact (`playwright-report`).

Tracking issue: [#259](https://github.com/merickvaughn/lifting-logbook/issues/259)

## Pages and the API Endpoints They Call

| Page | Endpoints |
|---|---|
| `/history` | `GET /programs/:p/lift-records`, `GET /programs/:p/training-maxes/history` |
| `/onboarding` (final step only) | `POST /programs/:p/cycles/initialize` |
| `/programs` | `GET /users/me/settings`, `GET /programs/custom` |
| Programs — switch | `POST /programs/:p/switch` |
| `/settings/training-maxes` | `GET /programs/:p/training-maxes`, `PATCH /programs/:p/training-maxes`, `GET /programs/:p/training-maxes/history` |
| `/settings/strength-goals` | `GET /programs/:p/strength-goals`, `PUT /programs/:p/strength-goals/:lift`, `DELETE /programs/:p/strength-goals/:lift` |

## Running the Tests

```bash
# Full suite (in-memory + DB). With Docker running, Jest globalSetup spins up
# a Postgres testcontainer automatically and runs migrations before tests:
npm test -w @lifting-logbook/api

# DB suite only:
npm run test:db -w @lifting-logbook/api

# CI passthrough: when DATABASE_URL is already set (e.g. the GitHub Actions
# postgres service container), globalSetup uses it directly and skips
# container startup. Run migrations yourself in this case before invoking jest.
```

## DB E2E connection defaults (issue #646)

Every DB E2E suite connects as the restricted **`lifting_app`** role by default — the same
non-superuser role the production application uses at runtime, with Row-Level Security fully
enforced (`FORCE ROW LEVEL SECURITY` on every userId-scoped table, per the `enable_rls`
migration). `jest.global-setup.js` provisions this role's password once and exposes it as
`LIFTING_TC_DATABASE_URL`.

A distinct, explicit opt-in, **`LIFTING_TC_OWNER_DATABASE_URL`**, exposes the superuser/owner
connection for suites that genuinely need to bypass RLS: seeding or cleaning up fixtures across
many synthetic users, or DB-layer assertions on RLS metadata itself that must run
role-independently.

**Rule of thumb:** if a test's Prisma calls stand in for what an authenticated HTTP request would
do, use the restricted sentinel — or better, let the app under test boot against the ambient
`DATABASE_URL`, which is already the restricted role. If a test needs to act as an omniscient
harness across multiple users' data, use the owner sentinel explicitly via
`datasources.db.url`. Never construct a Prisma client from ambient env when the intent is to
bypass RLS — ambient env now resolves to the restricted role by default.

This flips the pre-#646 default, under which every DB E2E suite connected as the superuser
bootstrap role and structurally could not detect a broken or missing RLS policy. That's exactly
how issue [#644](https://github.com/merickvaughn/lifting-logbook/issues/644) shipped and stayed live
for 3+ weeks: `RlsInterceptor` silently never set the `app.current_user_id` GUC, and no suite
besides `rls.db.e2e.spec.ts` ran with RLS actually capable of rejecting anything.

## Running locally when Docker is unavailable

The default behavior is **hard-fail with an actionable message** when Docker is
unreachable. globalSetup catches the underlying Testcontainers/daemon error and
re-throws a multi-line message that names the root cause and lists three recovery
options. This is intentional: a silent skip would let DB-touching changes ship
without local verification, with CI as the only gate.

The three recovery options the error names:

1. **Fix Docker Desktop.** On Windows, the most common cause is an unregistered
   `docker-desktop` WSL distro — see [issue #394](https://github.com/merickvaughn/lifting-logbook/issues/394)
   for the factory-reset procedure.
2. **Use `docker-compose.test.yml`.** Spin up the compose Postgres on 5433 and
   set `DATABASE_URL` so globalSetup takes the CI passthrough branch:
   ```bash
   docker-compose -f docker-compose.test.yml up -d --wait
   DATABASE_URL=postgresql://lifting:lifting@localhost:5433/lifting_test \
     npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma
   DATABASE_URL=postgresql://lifting:lifting@localhost:5433/lifting_test \
     npm test -w @lifting-logbook/api
   ```
3. **Explicit skip via `LIFTING_SKIP_DB_E2E=1`.** Only valid when the diff
   under test touches no DB code (no changes under `apps/api/prisma/`, no
   repository changes, no schema changes). When set, globalSetup logs a warning
   and returns; the DB E2E spec's `describeOrSkip` then leaves its blocks
   pending so non-DB tests still run:
   ```bash
   LIFTING_SKIP_DB_E2E=1 npm test -w @lifting-logbook/api
   ```
   Cite issue #394 in the PR body when this escape hatch is used.
