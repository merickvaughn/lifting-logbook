import { test, expect, type Page } from '@playwright/test';

// Non-cycle workouts (#1184): training outside any program.

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts (#746).
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

// Next dev compiles a route on its first visit, which on Windows can exceed the default
// timeouts (#698).
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await page.request.get(`${MOCK_API}/__reset?withNonCycleWorkout=true`);
  for (const [route, heading] of [
    ['/non-cycle/new', 'New non-cycle workout'],
    ['/non-cycle/1', 'Non-cycle workout 1'],
    ['/history', 'Lift History'],
  ]) {
    await page.goto(route, { timeout: 90_000 });
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({ timeout: 90_000 });
  }
  await page.close();
});

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset`);
});

const main = (page: Page) => page.getByRole('main');

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

/** Presses Tab until `target` has focus, as a keyboard user would. */
async function tabTo(page: Page, target: ReturnType<Page['locator']>) {
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached the element');
}

test('records a set with no plan, and History lists it', async ({ page }) => {
  await page.goto('/history');
  await page.getByRole('link', { name: 'Record a non-cycle workout' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New non-cycle workout' })).toBeVisible();

  await main(page).getByLabel('Lift').fill('squat');
  // The active program's max for the lift, from the mock's 300 lb squat.
  await expect(main(page).getByText('Training max 300 lbs.')).toBeVisible();
  await main(page).getByLabel('Weight (lbs)').fill('245');
  await main(page).getByLabel('Reps').fill('3');
  await main(page).getByRole('button', { name: 'Save set' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Non-cycle workout 1' })).toBeVisible();
  await expect(page).toHaveURL(/\/non-cycle\/1$/);
  await expect(main(page).getByText('squat set 1: 245 lbs × 3')).toBeVisible();

  await page.goto('/history');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Non-cycle workout 1' }) });
  await expect(row).toContainText('245 lbs × 3');
  // No training max or percentage beside it.
  await expect(row.getByRole('cell').nth(3)).toHaveText('—');
  await expect(row.getByRole('cell').nth(4)).toHaveText('—');
});

test('shows the workout, not an empty new one, on going back to it', async ({ page }) => {
  await page.goto('/non-cycle/new');
  await main(page).getByLabel('Lift').fill('squat');
  await main(page).getByLabel('Weight (lbs)').fill('245');
  await main(page).getByLabel('Reps').fill('3');
  await main(page).getByRole('button', { name: 'Save set' }).click();
  await expect(page).toHaveURL(/\/non-cycle\/1$/);

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'History' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Lift History' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/non-cycle\/1$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Non-cycle workout 1' })).toBeVisible();
  await expect(main(page).getByText('squat set 1: 245 lbs × 3')).toBeVisible();
});

test('records and edits a set by keyboard alone', async ({ page }) => {
  await page.goto('/non-cycle/new');
  const lift = main(page).getByLabel('Lift');
  await expect(main(page).getByLabel('Date')).not.toHaveValue('');

  await tabTo(page, lift);
  await page.keyboard.type('bench-press');
  await page.keyboard.press('Tab');
  await expect(main(page).getByLabel('Weight (lbs)')).toBeFocused();
  await page.keyboard.type('185');
  await page.keyboard.press('Tab');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Non-cycle workout 1' })).toBeVisible();

  await tabTo(page, main(page).getByRole('button', { name: 'Edit bench-press set 1' }));
  await page.keyboard.press('Enter');
  const reps = main(page).getByRole('listitem').getByLabel('Reps');
  await tabTo(page, reps);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('6');
  await page.keyboard.press('Enter');
  await expect(main(page).getByText('bench-press set 1: 185 lbs × 6')).toBeVisible();
});

test('fits a phone screen with no horizontal scroll', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset?withNonCycleWorkout=true`);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/non-cycle/1');
  await expect(main(page).getByText('squat set 3: 225 lbs × 5')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await main(page).getByRole('button', { name: 'Edit squat set 1' }).click();
  await expect(main(page).getByRole('listitem').getByLabel('Reps')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto('/non-cycle/new');
  await expect(main(page).getByLabel('Lift')).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('deletes a workout and returns to History', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset?withNonCycleWorkout=true`);
  await page.goto('/non-cycle/1');
  page.once('dialog', (dialog) => void dialog.accept());
  await main(page).getByRole('button', { name: 'Delete workout' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole('link', { name: 'Non-cycle workout 1' })).toHaveCount(0);
});
