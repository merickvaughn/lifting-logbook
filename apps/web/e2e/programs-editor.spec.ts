import { test, expect } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

// The /programs route and the editor's large lift <select> compile on-demand in Next dev; on
// Windows local dev the first cold compile can exceed Playwright's default timeouts, so the
// first navigating test would fail at page.goto before any assertion runs. Warm the route once
// here (generous headroom) so every test navigates to an already-compiled /programs. CI (Linux)
// compiles fast enough that this is effectively a no-op. See #698 / CLAUDE.md.
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await page.goto('/programs', { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Programs' })).toBeVisible({ timeout: 90_000 });
  await page.close();
});

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset`);
});

test('program editor: build multiple workout days, place a lift on two of them, then save', async ({
  page,
}) => {
  await page.goto('/programs');

  // Enter the "My Programs" editor (the New Program sub-tab is the default).
  await page.getByRole('button', { name: 'My Programs' }).click();
  await expect(page.getByLabel('Program Name')).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Program Name').fill('Upper/Lower Split');

  // Day 1 starts empty — add two lifts to it.
  await page.getByLabel('Add lift to Day 1').selectOption({ label: 'Back Squat' });
  await expect(page.getByRole('button', { name: 'Remove Back Squat #1 from Day 1' })).toBeVisible();
  await page.getByLabel('Add lift to Day 1').selectOption({ label: 'Bench Press' });
  await expect(page.getByRole('button', { name: 'Remove Bench Press #2 from Day 1' })).toBeVisible();

  // Add a second workout day and place Back Squat on it too — the same lift on two days,
  // which the pre-#751 editor could not express.
  await page.getByRole('button', { name: 'Add Day' }).click();
  await page.getByLabel('Add lift to Day 2').selectOption({ label: 'Back Squat' });
  await expect(page.getByRole('button', { name: 'Remove Back Squat #1 from Day 2' })).toBeVisible();

  // Save → on success onSaved fires and the view returns to the Browse tab, so the
  // editor form is removed from the DOM. (Plain Save, not Save & Switch, keeps this
  // focused on the workout-day feature and off the unrelated post-switch navigation.)
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Program Name')).toHaveCount(0, { timeout: 15_000 });
});
