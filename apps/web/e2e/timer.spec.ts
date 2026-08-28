import { test, expect } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset`);
});

// Timer settings and the in-flight run live in localStorage (`ll.timer.v1`).
// Playwright gives each test its own BrowserContext, so that storage already
// starts empty — deliberately NOT cleared via addInitScript, which re-runs on
// every navigation and would wipe the state the persistence tests below assert
// survives a reload.

// ---------------------------------------------------------------------------
// Workout detail — docked timer
// ---------------------------------------------------------------------------

test('start a timed workout — dock appears, expands, pauses and ends', async ({ page }) => {
  await page.goto('/cycle/1/workout/1/detail');

  // The timed plan is summarised before anything starts.
  await expect(page.getByText(/Timed plan: \d+ sets · \d+:\d{2} including rest/)).toBeVisible();

  const dock = page.getByRole('button', { name: 'Expand timer' });
  await expect(dock).toBeHidden();

  await page.getByRole('button', { name: '▶ Start timed workout' }).click();
  await expect(dock).toBeVisible();
  await expect(page.getByRole('timer').first()).toBeVisible();

  // Expand into the full-screen sheet.
  await dock.click();
  const sheet = page.getByRole('dialog', { name: 'Workout timer' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/Set \d+ of \d+/)).toBeVisible();

  // Pause and resume from inside the sheet.
  await sheet.getByRole('button', { name: 'Pause' }).click();
  await expect(sheet.getByRole('button', { name: 'Resume' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Resume' }).click();
  await expect(sheet.getByRole('button', { name: 'Pause' })).toBeVisible();

  // Escape collapses the sheet but leaves the session running.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(dock).toBeVisible();

  // Ending the session removes the dock entirely.
  await dock.click();
  await page.getByRole('dialog').getByRole('button', { name: 'End timer' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(dock).toBeHidden();
});

test('start the timer at a chosen set from the lift list', async ({ page }) => {
  await page.goto('/cycle/1/workout/1/detail');

  // The set rows sit in a `display: none` panel until the lift is expanded, so
  // the play control is not actionable before this click.
  await page.getByRole('button', { name: /warm-up/ }).first().click();

  const play = page.getByRole('button', { name: /^Start timer at .+ Set 1$/ }).first();
  await expect(play).toBeVisible();
  await play.click();

  await expect(page.getByRole('button', { name: 'Expand timer' })).toBeVisible();
  // The set the timer is working through is marked as the active row.
  await expect(page.locator('[class*="setRowActive"]').first()).toBeVisible();
});

test('the countdown survives a reload — the run is picked up again', async ({ page }) => {
  await page.goto('/cycle/1/workout/1/detail');
  await page.getByRole('button', { name: '▶ Start timed workout' }).click();
  await expect(page.getByRole('button', { name: 'Expand timer' })).toBeVisible();

  await page.reload();

  // The persisted run belongs to this workout, so the dock comes straight back.
  await expect(page.getByRole('button', { name: 'Expand timer' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Timer page
// ---------------------------------------------------------------------------

test('the timer page shows the live dial and the session queue', async ({ page }) => {
  await page.goto('/cycle/1/workout/1/timer');

  await expect(page.getByRole('tab', { name: 'Timer' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('Ready')).toBeVisible();
  await expect(page.getByText(/\d+ timed sets · \d+:\d{2} estimated/)).toBeVisible();

  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeEnabled();
  await start.click();

  await expect(page.getByText(/Set \d+ of \d+/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled();
});

test('timer settings persist and change the plan estimate', async ({ page }) => {
  await page.goto('/cycle/1/workout/1/timer');

  const estimate = page.getByText(/\d+ timed sets · \d+:\d{2} estimated/);
  const before = await estimate.textContent();

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Heavy day' }).click();

  // Reload: the preset was written to localStorage, so it survives.
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('radio', { name: 'Heavy day' })).toBeChecked();

  await page.getByRole('tab', { name: 'Timer' }).click();
  await expect(estimate).not.toHaveText(before ?? '');
});

test('the timer page links back to the workout detail page', async ({ page }) => {
  await page.goto('/cycle/1/workout/1/timer');

  await page.getByRole('link', { name: /Week \d+ · Workout \d+/ }).click();
  await expect(page).toHaveURL(/\/cycle\/1\/workout\/1\/detail$/);
});
