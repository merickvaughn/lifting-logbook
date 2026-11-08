import { test, expect } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

const EDIT = '/macrocycle/1/workout/1/detail/manage-lifts/edit';

// Next dev compiles a route on its first visit, which on Windows can exceed the default
// timeouts (#698). Warm it once so each test runs against a compiled route.
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await page.goto(`${EDIT}/squat`, { timeout: 90_000 });
  await page.close();
});

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset`);
});

// #1190: the page 500'd for every lift, since the mock had no metadata route and nothing
// turned an unknown lift into notFound(). Non-404 failures are covered in page.test.tsx.
test('an unknown lift gets the not-found page with a 404', async ({ page }) => {
  const response = await page.goto(`${EDIT}/not-a-lift`);
  expect(response?.status()).toBe(404);
  // A role query: Next's 500 page also carries this text, hidden.
  await expect(page.getByRole('heading', { name: 'This page could not be found.' })).toBeVisible();
});

test('a lift in the workout opens its edit form', async ({ page }) => {
  const response = await page.goto(`${EDIT}/squat`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Edit Lift: squat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible();
});
