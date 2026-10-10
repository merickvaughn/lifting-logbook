# Staging Integration Tests

End-to-end tests that run against the live Cloud Run staging environment.
They are not a substitute for unit or component tests — they verify that the
full auth → web → API stack is wired correctly after a deploy.

## How to run locally

Prerequisites:
- The staging environment must be deployed (Terraform + Cloud Run).
- You must have a test account in the staging Clerk instance (see Test Account Setup below).
- You need the staging Clerk secret key and publishable key.

Set the following environment variables, then run the tests:

```bash
export STAGING_WEB_URL=https://<staging-web-cloud-run-url>
export STAGING_API_URL=https://<staging-api-cloud-run-url>
export STAGING_CLERK_TEST_EMAIL=<test-account-email>
export CLERK_SECRET_KEY=<staging-clerk-backend-secret-key>
export CLERK_PUBLISHABLE_KEY=<staging-clerk-publishable-key>  # no NEXT_PUBLIC_ prefix

cd apps/web
npx playwright test --config=playwright.config.staging.ts
```

The staging web and API URLs can be found with:

```bash
gcloud run services list --project=<staging-project-id> --region=us-central1
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `STAGING_WEB_URL` | Yes | Base URL of the staging Next.js web service |
| `STAGING_API_URL` | No | URL of the staging NestJS API service — set in CI but not used directly by tests (auth propagation test uses `/api/health` route handler instead) |
| `STAGING_CLERK_TEST_EMAIL` | Yes | Email of the test account in the staging Clerk instance |
| `CLERK_SECRET_KEY` | Yes | Staging Clerk Backend API secret key — used by global setup to create a sign-in token, bypassing MFA |
| `CLERK_PUBLISHABLE_KEY` | Yes | Staging Clerk publishable key without the `NEXT_PUBLIC_` prefix — required by `@clerk/testing`'s `clerkSetup()` |

In CI, all of these are injected automatically by `.github/workflows/staging.yml`.
`CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` are fetched from GCP Secret Manager at runtime;
the test email is stored in the GitHub `staging` environment secret `STAGING_CLERK_TEST_EMAIL`.

## Test account setup

The global setup (`staging.setup.ts`) signs in once and saves the browser session to
`playwright/.auth/user.json`. Individual tests load that session via `storageState`.

To create the test account:

1. Open the staging Clerk dashboard → **Users** → **Create user**.
2. Set the email to the value you will use for `STAGING_CLERK_TEST_EMAIL`.
3. Set a password (it is not used by the automated setup, but Clerk requires one).
4. The account may have MFA enabled — the sign-in token strategy bypasses it.

The test account requires no pre-existing app data. All tests are written to pass on a
freshly created account with zero lift records, no active program, and no training maxes.

Note: the onboarding write-path test (see "What the tests cover" below) creates and then
deletes a macrocycle for this account on every run, via a test-support cleanup route. If a CI run
is interrupted mid-test (e.g. a hard timeout kill), the account may be left with a stray
macrocycle for the `rpt` program; the next run's pre-test cleanup step removes it automatically.

## Authentication strategy

The global setup uses the [Clerk Backend SDK sign-in token](https://clerk.com/docs/reference/backend-api/tag/Sign-in-Tokens)
strategy rather than the UI email/password flow. A sign-in token bypasses all authentication
factors (including TOTP/SMS MFA), which the UI flow cannot handle automatically.

The flow:
1. `clerkSetup()` fetches a Clerk testing token — allows the SDK to bypass bot-detection.
2. The backend SDK creates a one-time sign-in token for the test user.
3. Playwright navigates to `/sign-in` and calls `window.Clerk.client.signIn.create({ strategy: 'ticket', ticket })` via `page.evaluate()`.
4. The resulting session is saved to `playwright/.auth/user.json` and reused by all tests.

See [ADR-023](../../../docs/adr/ADR-023-staging-integration-test-design.md) for the full
rationale.

## What the tests cover (and don't cover)

The tests verify that the deployed stack is correctly wired:

| Test | What it checks |
|---|---|
| Home page renders | Static page is served |
| Programs catalog loads | Programs tab renders (static catalog + auth-gated custom programs) |
| History page tabs render | Auth-gated page renders structure (data may be empty) |
| /macrocycle resolves to dashboard or onboarding | Server-side redirect logic works |
| **Auth propagation** | `GET /api/health` (Next.js route handler) checks two things: (1) `auth().userId` non-null (Clerk session valid server-side), (2) `GET ${API_URL}/health` returns 200 (API reachable) |
| **Onboarding write path** | Full onboarding flow (sign in → choose program → confirm maxes → Start My Program) actually writes a new macrocycle and the dashboard renders. Self-cleaning via `/api/test-support/reset-macrocycle` before and after — closes the gap where #644 (RLS silently disabled) could ship undetected because every other test here is read-only. |

The auth propagation test is the only one that explicitly verifies the API is reachable and
that the Clerk token is valid. Tests 1–4 assert page structure; because the server components
handle API errors gracefully (redirect or render empty), they pass even if the API is down.
The onboarding write-path test is the only one that performs a real write — see [ADR-023](../../../docs/adr/ADR-023-staging-integration-test-design.md)'s
amended "Test scope" consequence for why this one deliberate exception exists.

## Playwright config

The staging-specific config is at `apps/web/playwright.config.staging.ts`. It:
- Targets only `staging.spec.ts` (not the local smoke or scheduling tests)
- Runs serially (`workers: 1`, `fullyParallel: false`) — the session is shared
- Enables 2 retries in CI for transient flakiness
- Uses `storageState: 'playwright/.auth/user.json'` for every test
