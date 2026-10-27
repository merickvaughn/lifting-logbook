import { test, expect, type Page } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

// Focus work setup (#1057). Warm the route once: its first cold compile in Next dev on
// Windows can outlast the default test timeout (#698).
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await page.goto('/programs/focus', { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Focus work', level: 1 })).toBeVisible({ timeout: 90_000 });
  await page.close();
});

/** Waits for the save `method` sends to `/focus…`, so a reload reads what it stored. */
function saved(page: Page, method: string) {
  return page.waitForResponse((res) => res.request().method() === method && new URL(res.url()).pathname.startsWith('/focus'));
}

test('Programs links to focus work, and a new focus block saves', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset`);
  await page.goto('/programs');
  await page.getByRole('link', { name: 'Focus work' }).click();
  await expect(page).toHaveURL(/\/programs\/focus$/);
  await expect(page.getByText('No focus blocks are running. Add one below.')).toBeVisible();

  await page.getByRole('combobox', { name: 'Area for a new focus block' }).selectOption('Triceps');
  const created = saved(page, 'POST');
  await page.getByRole('button', { name: '+ Add focus block' }).click();
  await created;

  // The new focus block opens for editing.
  // The card's own toggle, not its "Raise/Lower priority of Triceps" buttons.
  const cardToggle = /^Triceps (Monthly|Quarterly)/;
  const toggle = page.getByRole('button', { name: cardToggle, expanded: true });
  await expect(toggle).toContainText('Monthly');
  const patched = saved(page, 'PATCH');
  await page.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: 'Quarterly' }).click();
  await patched;
  await expect(toggle).toContainText('Quarterly');

  await page.reload();
  await expect(page.getByRole('button', { name: cardToggle })).toContainText('Quarterly');
});

test('the program page links to focus work', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset`);
  await page.goto('/macrocycle/1/program');
  await expect(page.getByRole('link', { name: 'Set up focus work' })).toHaveAttribute('href', '/programs/focus');
});

test('reorders focus blocks, saves the daily focus guide, and plans this week', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset?withFocusBlocks=true`);
  await page.goto('/programs/focus');

  // This week lists every active focus block's lifts for each workout.
  await expect(page.getByText('Every workout fits the guide')).toBeVisible();
  await expect(page.getByText('Lateral Raise, Face Pull, Hammer Curl').first()).toBeVisible();

  const reordered = saved(page, 'PUT');
  await page.getByRole('button', { name: 'Raise priority of Biceps' }).click();
  await reordered;
  const guide = saved(page, 'PUT');
  await page.getByRole('button', { name: 'Increase Extra sets per day' }).click();
  await guide;

  await page.reload();
  const toggles = page.getByRole('button', { expanded: false }).filter({ hasText: /Shoulders|Biceps/ });
  await expect(toggles.first()).toContainText('Biceps');
  await expect(page.getByRole('status', { name: 'Extra sets per day' })).toHaveText('10');
  await expect(page.getByText('Hammer Curl, Lateral Raise, Face Pull').first()).toBeVisible();
});
