import { test, expect, type Page } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset`);
});

const WORKOUT = '/macrocycle/1/workout/1';

const trigger = (page: Page) => page.getByRole('button', { name: 'Rep max calculator' });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Rep max calculator' });

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

for (const [view, route] of [
  ['workout', WORKOUT],
  ['workout detail', `${WORKOUT}/detail`],
  ['lift detail', `${WORKOUT}/detail/squat`],
  ['rest timer', `${WORKOUT}/timer`],
  ['training maxes', '/settings/training-maxes'],
] as const) {
  test(`opens from the ${view} view, at phone width`, async ({ page }) => {
    // A first visit compiles the route on demand, which on Windows can exceed the default.
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(route);

    await trigger(page).click({ timeout: 90_000 });
    await expect(dialog(page)).toBeVisible();
    await expectNoHorizontalScroll(page);

    await dialog(page).getByLabel('Weight (lbs)').fill('200');
    await dialog(page).getByLabel('Reps').fill('5');
    await expect(dialog(page).getByText('Estimated one-rep max').locator('..')).toContainText('225 lbs');
    await expectNoHorizontalScroll(page);

    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toBeHidden();
    await expectNoHorizontalScroll(page);
  });
}

test('keeps an unsaved set and the URL', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(WORKOUT);

  const weight = page.getByLabel('Weight in lbs').first();
  const reps = page.getByLabel('Reps').first();
  await weight.fill('255', { timeout: 90_000 });
  await reps.fill('7');
  const url = page.url();

  await trigger(page).click();
  await dialog(page).getByLabel('Weight (lbs)').fill('200');
  await dialog(page).getByLabel('Reps').fill('5');
  await expect(dialog(page).getByText('Estimated one-rep max')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await expect(weight).toHaveValue('255');
  await expect(reps).toHaveValue('7');
  expect(page.url()).toBe(url);
});

test('works by keyboard alone, at phone width', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/settings/training-maxes');
  await expect(trigger(page)).toBeVisible({ timeout: 90_000 });

  // Reach the button by tabbing, as a keyboard user would.
  const isOnTrigger = () =>
    page.evaluate(() => document.activeElement?.textContent === 'Rep max calculator');
  for (let presses = 0; presses < 40 && !(await isOnTrigger()); presses++) {
    await page.keyboard.press('Tab');
  }
  await expect(trigger(page)).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel('Weight (lbs)')).toBeFocused();

  await page.keyboard.type('200');
  await page.keyboard.press('Tab');
  await expect(dialog(page).getByLabel('Reps')).toBeFocused();
  await page.keyboard.type('5');
  await expect(dialog(page).getByText('Estimated one-rep max').locator('..')).toContainText('225 lbs');
  await expectNoHorizontalScroll(page);

  // Round the dialog both ways: focus never reaches the page behind it.
  const focusIsInDialog = () =>
    page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
  for (const shift of [false, true]) {
    for (let presses = 0; presses < 5; presses++) {
      await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
      expect(await focusIsInDialog()).toBe(true);
    }
  }

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});
