import { test, expect, Page } from '@playwright/test';

// Staging integration tests — run against the live Cloud Run staging environment.
// Auth state is provided by staging.setup.ts (signs in once, saves session).
//
// Constraints:
// - No mock API, no __reset endpoint
// - Assertions check structure/presence only — not hardcoded seed data values
// - Write-path tests must be idempotent or self-cleaning
//   (see test 6 for the first concrete example: onboarding write-path, self-
//   cleaned via /api/test-support/reset-cycle before and after)

// ---------------------------------------------------------------------------
// 1. Home page redirects signed-in users to the authenticated landing page
//
// Per #384, `/` is now an async server component that calls `auth()` and
// redirects signed-in users to `/cycle`. The marketing card is reserved for
// signed-out visitors and is exercised by Jest in apps/web/app/page.test.tsx
// (renderToStaticMarkup assertions). The staging suite runs with a saved
// Clerk session, so the only observable behavior here is the redirect itself.
// `/cycle` further redirects to `/onboarding` when the test user has no
// active cycle, so accept either landing URL.
// ---------------------------------------------------------------------------

test('home page redirects signed-in users to /cycle (or /onboarding)', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/(cycle(\/\d+)?|onboarding)$/, { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// 2. Programs catalog loads
//
// Structure-only assertion is intentional: the program catalog is rendered
// from static data in apps/web/lib/programs.ts, so the page renders even
// when the `.catch(() => DEFAULT_SETTINGS)` and `.catch(() => [])` fallbacks
// in apps/web/app/(authed)/programs/page.tsx:15-16 are exercised. The staging test
// user has no custom programs, so no real-data assertion would distinguish
// the success and fallback paths here. API-success detection is delegated
// to test 5 (auth/API propagation against /api/health).
// ---------------------------------------------------------------------------

test('programs page catalog loads', async ({ page }) => {
  await page.goto('/programs');
  await expect(page.getByRole('heading', { name: 'Programs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose This Program' }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. History page tabs render
//
// Structure-only assertion is intentional: the staging test user has no
// records, so the success path renders empty tabs with no visible rows. The
// two fetches in apps/web/app/(authed)/history/page.tsx (the two `.catch` fallbacks,
// annotated `fallback-covered-by` → this spec) catch a failure
// into a `[]` fallback that also flips a `loadFailed` flag driving a
// non-blocking "couldn't load" banner — but that banner appears only when a
// fetch REJECTS, which the live staging API (asserted up by test 5,
// /api/health) does not do here. So no real-data assertion distinguishes the
// success and fallback paths on this page; API-success detection stays
// delegated to test 5.
// ---------------------------------------------------------------------------

test('history page renders both tabs', async ({ page }) => {
  await page.goto('/history');
  await expect(page.getByRole('tab', { name: 'Lift History' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'TM Timeline' })).toBeVisible();
  await page.getByRole('tab', { name: 'TM Timeline' }).click();
  await expect(page.getByRole('tab', { name: 'TM Timeline' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

// ---------------------------------------------------------------------------
// 4. Cycle dashboard renders (or onboarding if no cycle exists)
//
// The URL-or-onboarding tolerance is intentional: the staging test user
// has no active cycle, so the try/catch in apps/web/app/(authed)/cycle/page.tsx:10-16
// redirects to /onboarding on both "no cycle" and "API failed". This test
// cannot distinguish the two; API-failure detection is delegated to test 5
// which calls /api/health and asserts a specific HTTP 200.
// ---------------------------------------------------------------------------

test('cycle resolves to dashboard or onboarding', async ({ page }) => {
  await page.goto('/cycle');
  await expect(page).toHaveURL(/\/(cycle\/\d+|onboarding)/, { timeout: 15_000 });
  if (page.url().includes('/onboarding')) {
    await expect(page.getByRole('heading', { name: 'Get Started' })).toBeVisible();
  }
});

// ---------------------------------------------------------------------------
// 5. Auth propagation — verifies the full auth stack works end-to-end
//
// Tests 1–4 assert page structure only. Because the server components swallow
// API errors (redirect or render empty), they pass even if the API is down.
// This test directly calls the API with the Clerk JWT to confirm:
//   (a) the session token written by global setup is still valid
//   (b) the API service is reachable from the test runner
//   (c) auth headers are accepted (not stripped, not expired)
// ---------------------------------------------------------------------------

test('authenticated API call succeeds (auth propagation)', async ({ page }) => {
  // Navigate first so the storageState cookies are active in the browser context.
  await page.goto('/');

  // Use page.evaluate() to call /api/health via browser-native fetch, which
  // guarantees the browser's own cookie jar (including Clerk session cookies) is
  // used.  page.request.get() goes through a separate network stack and may not
  // forward all cookies that Clerk's middleware depends on.
  //
  // /api/health is a Next.js route handler that calls auth().getToken() server-side
  // and then hits the backend API — verifying the full auth path without relying
  // on the client-side Clerk SDK (which has a 60-second JWT cache in dev mode).
  //
  // Status codes from the route handler:
  //   200 — Clerk session valid; API /health returned 200 (or no GCP metadata, auth-only)
  //   401 — no Clerk session (auth().userId is null — storageState not recognised)
  //   503 — Clerk session valid but GET ${API_URL}/health failed (IAM, network, or API down)
  const { status, body } = await page.evaluate(async () => {
    const r = await fetch('/api/health');
    const text = await r.text();
    return { status: r.status, body: text };
  });

  expect(
    status,
    `Expected 200 from /api/health — got ${status}. Body: ${body}. ` +
      '401=Clerk session not recognised server-side (storageState may be stale). ' +
      '503=Clerk valid but API call failed — check API_URL, IAM (web_invoker_on_api), or Cloud Run logs. ' +
      'Check that the staging API is deployed and Clerk is configured correctly.',
  ).toBe(200);
});

// ---------------------------------------------------------------------------
// 6. Onboarding write path — sign in -> choose program -> confirm maxes ->
//    Start My Program -> cycle dashboard renders
//
// This is the only write-path test in this file. It exists to close the gap
// that let #644 (RLS silently disabled) ship undetected: every other test here
// is read-only and would pass even if every write to Postgres were silently
// failing. Per the file-level constraint above ("write-path tests must be
// idempotent or self-cleaning"), this test deletes the test account's current
// cycle via the /api/test-support/reset-cycle route handler BEFORE it runs
// (so a fresh cycle-1 creation is actually exercised even on a re-run) AND
// again AFTER (so a left-behind cycle never causes a future run of this test
// to silently take the "cycle already exists" branch of switchProgram instead
// of genuinely creating one — see apps/api/src/programs/switch-program.controller.ts).
//
// Cleanup runs via test.beforeAll/afterAll with the `request` fixture rather
// than a try/finally in the test body — Playwright's per-test timeout does not
// reliably let a `finally` block complete, whereas afterAll is guaranteed to
// run regardless of how the test ended.
//
// The reset call uses the exact same auth path (X-Clerk-Authorization via
// lib/api.ts) that "Start My Program" itself uses — see
// docs/adr/ADR-023-staging-integration-test-design.md for why the two more
// "obvious" alternatives (server-side getToken()+forward, client-side
// getToken()+direct-fetch) are both already known to be flaky against this
// specific staging Clerk instance.
// ---------------------------------------------------------------------------

test.describe('onboarding write path (creates and cleans up real data)', () => {
  const RESET_URL = '/api/test-support/reset-cycle?program=rpt';

  test.beforeAll(async ({ request }) => {
    // Defensive: a prior run's own cleanup may not have completed (CI kill, etc).
    // Asserted, not fire-and-forget: a silently-failing reset here (e.g. an
    // expired Clerk session returning 401) would leave a stale cycle in place,
    // and switchProgram silently reuses an existing cycle rather than erroring
    // (switch-program.controller.ts) — so the test below would still pass
    // without ever exercising a genuine first-time write, defeating the entire
    // point of this suite with no visible signal. Fail loudly here instead.
    const res = await request.delete(RESET_URL);
    expect(res.ok(), `Pre-test cleanup failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    const res = await request.delete(RESET_URL);
    expect(res.ok(), `Post-test cleanup failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  });

  test('sign in -> choose program -> confirm maxes -> Start My Program -> cycle dashboard renders', async ({ page }: { page: Page }) => {
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: 'Get Started' })).toBeVisible();

    // Step 1: Choose Method — pick "Enter training maxes" (weight-only, no reps needed)
    await page.getByRole('button', { name: 'Enter training maxes' }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 2: Choose Program — switch to Intermediate tab, select RPT
    await page.getByRole('tab', { name: 'Intermediate' }).click();
    await page.getByRole('button', { name: /Reverse Pyramid Training/i }).click();
    await page.getByRole('button', { name: 'Choose This Program' }).click();

    // Step 3: Enter Lifts — RPT's 9 lifts are pre-seeded; enter a TM for each
    const rptLifts = [
      'Bench Press', 'Barbell Row', 'Overhead Press',
      'Squat', 'Romanian Deadlift', 'Calf Raises',
      'Deadlift', 'Weighted Pull-ups', 'Dips',
    ];
    for (const lift of rptLifts) {
      await page.getByLabel(`${lift} weight`, { exact: true }).fill('225');
    }
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 4: Confirm Maxes — submit to create the first cycle
    await page.getByRole('button', { name: 'Start My Program' }).click();

    // Lands on the cycle dashboard — the actual write-path assertion.
    await expect(page).toHaveURL(/\/cycle\/1/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /cycle/i }).first()).toBeVisible();

    // ---------------------------------------------------------------------
    // Reschedule write path — appended here (rather than a standalone test)
    // to reuse the cycle/workout this test already created and cleans up,
    // avoiding new seed/cleanup plumbing.
    //
    // This specifically exercises RescheduleForm.tsx -> lib/client-api.ts,
    // the ONLY write path in the app that fetches PUBLIC_API_URL directly
    // from the browser (every other write in this file, including "Start My
    // Program" above, goes through a Next.js Server Action using the
    // server-side X-Clerk-Authorization header via lib/api.ts). A browser
    // fetch to PUBLIC_API_URL is genuinely cross-origin against Cloud Run's
    // own URL, so it is the only path that actually triggers a CORS
    // preflight against the API's Cloud Run IAM policy — see ADR-032. None
    // of the tests above would have caught the ~month-long production outage
    // that motivated ADR-032 (#766); this one would have.
    // ---------------------------------------------------------------------
    await page.goto('/cycle/1/workout/1/detail');
    await page.getByRole('button', { name: '📅 Reschedule' }).click();

    const newDate = new Date();
    newDate.setDate(newDate.getDate() + 3);
    const newDateStr = newDate.toISOString().slice(0, 10);
    await page.locator('#new-date').fill(newDateStr);
    await page.getByRole('button', { name: 'Move' }).click();

    // Success collapses the form back to the trigger button with no error shown; failure
    // (including the pre-ADR-032 CORS 403) leaves the form open with the "Failed to
    // reschedule" message visible. Assert the terminal success state FIRST: the trigger
    // button only reappears after the request resolves successfully, so this is what
    // actually proves the write path worked. Leading with the negative error assertion
    // would false-green — immediately after "Move" the error is not yet rendered regardless
    // of outcome, so `.not.toBeVisible()` would pass during the in-flight window even for a
    // request that ultimately fails.
    await expect(page.getByRole('button', { name: '📅 Reschedule' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Failed to reschedule. Please try again.')).not.toBeVisible();
  });
});
