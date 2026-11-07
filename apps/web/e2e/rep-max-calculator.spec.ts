import { test, expect, type Page } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

const WORKOUT = '/macrocycle/1/workout/1';

const VIEWS = [
  ['workout', WORKOUT],
  ['workout detail', `${WORKOUT}/detail`],
  ['lift detail', `${WORKOUT}/detail/squat`],
  ['rest timer', `${WORKOUT}/timer`],
  ['training maxes', '/settings/training-maxes'],
] as const;

const trigger = (page: Page) => page.getByRole('button', { name: 'Rep max calculator' });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Rep max calculator' });

// Next dev compiles a route on its first visit, which on Windows can exceed the default
// timeouts (#698). Warm them here so a missing button fails each test quickly.
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  const manageLifts = `${WORKOUT}/detail/manage-lifts`;
  for (const route of [...VIEWS.map(([, route]) => route), manageLifts]) {
    await page.goto(route, { timeout: 90_000 });
    await expect(trigger(page)).toBeVisible({ timeout: 90_000 });
  }
  await page.close();
});

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset`);
});

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

/** Opens the dialog, retrying because a click that arrives before hydration is lost. */
async function openCalculator(page: Page) {
  await expect(async () => {
    if (!(await dialog(page).isVisible())) await trigger(page).click({ timeout: 2_000 });
    await expect(dialog(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

for (const [view, route] of VIEWS) {
  test(`opens from the ${view} view without moving the page, at phone width`, async ({ page }) => {
    // Short enough that every view can scroll.
    await page.setViewportSize({ width: 375, height: 600 });
    await page.goto(route);
    await expect(page.getByRole('banner').getByRole('button', { name: 'Rep max calculator' })).toBeVisible();

    // Partway down the page, the button is still on screen.
    await page.evaluate(() => window.scrollTo(0, 100));
    await expect.poll(() => scrollY(page)).toBe(100);
    await expect(trigger(page)).toBeInViewport();

    await openCalculator(page);
    await expectNoHorizontalScroll(page);

    await dialog(page).getByLabel('Weight (lbs)').fill('200');
    await dialog(page).getByLabel('Reps').fill('5');
    await expect(dialog(page).getByText('Estimated one-rep max').locator('..')).toContainText('225 lbs');
    await expectNoHorizontalScroll(page);

    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toBeHidden();
    await expectNoHorizontalScroll(page);
    expect(await scrollY(page)).toBe(100);
  });
}

test('stays out of the header on views without it', async ({ page }) => {
  await page.goto('/glossary');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);
});

test('keeps an unsaved set and the URL', async ({ page }) => {
  await page.goto(WORKOUT);

  const weight = page.getByLabel('Weight in lbs').first();
  const reps = page.getByLabel('Reps').first();
  await weight.fill('255');
  await reps.fill('7');
  const url = page.url();

  // The logger restores typed values from localStorage after a remount or reload, so the
  // values alone can't tell the page survived. A marker on the input is lost to either.
  await weight.evaluate((input) => input.setAttribute('data-rep-max-marker', 'true'));

  await openCalculator(page);
  await dialog(page).getByLabel('Weight (lbs)').fill('200');
  await dialog(page).getByLabel('Reps').fill('5');
  await expect(dialog(page).getByText('Estimated one-rep max')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await expect(weight).toHaveValue('255');
  await expect(reps).toHaveValue('7');
  expect(page.url()).toBe(url);
  await expect(weight).toHaveAttribute('data-rep-max-marker', 'true');
});

test('closes when the browser goes back, and leaves nothing to press behind it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 500 });
  await page.goto(`${WORKOUT}/detail`);
  const backUrl = page.url();

  // Opening it first proves the page has hydrated, so the link below moves client-side and
  // the layout holding the calculator stays mounted.
  await openCalculator(page);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect.poll(() => scrollY(page)).toBe(200);

  // Where Back lands with the dialog closed. The timer dock focuses its start button when this
  // view mounts, which can scroll it, so the position to keep is this one, not the 200.
  const manageLifts = page.getByRole('link', { name: /manage lifts/i });
  await manageLifts.click();
  await expect(page).toHaveURL(/manage-lifts/);
  await page.goBack();
  await expect(page).toHaveURL(backUrl);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(0);
  const landing = await scrollY(page);

  await manageLifts.click();
  await expect(page).toHaveURL(/manage-lifts/);
  await openCalculator(page);
  await dialog(page).getByLabel('Weight (lbs)').fill('200');

  await page.goBack();
  await expect(page).toHaveURL(backUrl);
  await expect(dialog(page)).toBeHidden();
  await expect.poll(() => scrollY(page)).toBe(landing);

  await openCalculator(page);
  await expect(dialog(page).getByLabel('Weight (lbs)')).toHaveValue('200');
});

test('explains text a number field can not read', async ({ page }) => {
  await page.goto(WORKOUT);
  await openCalculator(page);

  // keyboard.type rather than fill, which refuses text a number input can't hold.
  await dialog(page).getByLabel('Weight (lbs)').focus();
  await page.keyboard.type('-');
  await expect(dialog(page).getByRole('status')).toHaveText('Enter a number.');
  await expect(dialog(page).getByLabel('Weight (lbs)')).toHaveAttribute('aria-invalid', 'true');

  await page.keyboard.press('Backspace');
  await page.keyboard.type('200e');
  await expect(dialog(page).getByRole('status')).toHaveText('Enter a number.');

  await page.keyboard.press('Backspace');
  await expect(dialog(page).getByRole('status')).toBeEmpty();
  await expect(dialog(page).getByLabel('Weight (lbs)')).toHaveValue('200');
});

test('works by keyboard alone, at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/settings/training-maxes');
  await expect(trigger(page)).toBeVisible();

  // Reach the button by tabbing, as a keyboard user would.
  const isOnTrigger = () =>
    page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Rep max calculator');
  for (let presses = 0; presses < 20 && !(await isOnTrigger()); presses++) {
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

  await page.keyboard.press('Tab');
  await expect(dialog(page).getByLabel('Round down to')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(dialog(page).getByLabel('Round down to')).toHaveValue('5');

  // Round the dialog both ways: focus never reaches the page behind it.
  const focusIsInDialog = () =>
    page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
  for (const shift of [false, true]) {
    for (let presses = 0; presses < 6; presses++) {
      await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
      expect(await focusIsInDialog()).toBe(true);
    }
  }

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});
