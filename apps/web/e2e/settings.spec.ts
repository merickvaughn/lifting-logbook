import { test, expect } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

test.beforeEach(async ({ request }) => {
  // The Import wizard's Source step lists custom programs; opt the mock into one
  // so the wizard renders its normal flow when reached via the hub link.
  await request.get(`${MOCK_API}/__reset?withCustomProgram=true`);
});

// ---------------------------------------------------------------------------
// Settings hub: the section tabs are present and cross-navigate.
// ---------------------------------------------------------------------------

test('settings hub exposes the sections and the sub-nav cross-navigates', async ({ page }) => {
  await page.goto('/settings');

  const subNav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(subNav.getByRole('link', { name: 'Training Maxes' })).toHaveAttribute(
    'href',
    '/settings/training-maxes',
  );
  await expect(subNav.getByRole('link', { name: 'Strength Goals' })).toHaveAttribute(
    'href',
    '/settings/strength-goals',
  );
  await expect(subNav.getByRole('link', { name: 'Schedule' })).toHaveAttribute(
    'href',
    '/settings/schedule',
  );
  await expect(subNav.getByRole('link', { name: 'Weight Rounding' })).toHaveAttribute(
    'href',
    '/settings/weight-rounding',
  );
  await expect(subNav.getByRole('link', { name: 'Units' })).toHaveAttribute(
    'href',
    '/settings/units',
  );

  // The sub-nav actually moves between sections and marks the target active.
  await subNav.getByRole('link', { name: 'Weight Rounding' }).click();
  await expect(page).toHaveURL(/\/settings\/weight-rounding$/);
  await expect(
    page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Weight Rounding' }),
  ).toHaveAttribute('aria-current', 'page');
});

// ---------------------------------------------------------------------------
// Settings hub: the Units section round-trips the lbs/kg preference.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Training maxes: the offer to set up a max for a lift with sets and none (#1246).
// ---------------------------------------------------------------------------

test('training maxes offers setup for a lift with logged sets and no max', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset?withMissingMax=true`);
  await page.goto('/settings/training-maxes');

  const section = page.getByRole('region', { name: 'Lifts without a training max' });
  const input = section.getByLabel('Romanian Deadlift training max');
  await expect(input).toHaveValue('100');
  await expect(section.getByText('Estimated from 100 lbs × 5 on 6 Jan 2025')).toBeVisible();

  await section.getByRole('button', { name: "Don't ask again" }).click();
  const hidden = section.getByText('Hidden from prompts (1)');
  await expect(hidden).toBeVisible();
  await hidden.click();
  await section.getByRole('button', { name: 'Ask again' }).click();
  await expect(section.getByText(/Hidden from prompts/)).toHaveCount(0);

  await section.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Training max set up for Romanian Deadlift.' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Lifts without a training max' })).toHaveCount(0);
  // The table below now lists the lift with its new max, saved under the stored id (#1290). The
  // table still labels its rows by that id, as it does every max; #1291 tracks naming them.
  await expect(page.getByLabel('romanian-deadlift training max')).toHaveValue('100');
});

test('units section saves the selected weight unit', async ({ page }) => {
  await page.goto('/settings/units');

  await expect(page.getByRole('heading', { name: 'Units' })).toBeVisible();
  await page.getByLabel('Weight unit').selectOption('kg');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(/^Saved at /)).toBeVisible();
  await expect(page.getByLabel('Weight unit')).toHaveValue('kg');
});

// ---------------------------------------------------------------------------
// Settings → Progression: the lifter's default progression saves and survives a reload (#1210).
// ---------------------------------------------------------------------------

test('progression section saves a default progression with its rep range', async ({ page }) => {
  await page.goto('/settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Progression' })
    .click();
  await expect(page).toHaveURL(/\/settings\/progression$/);
  await expect(page.getByRole('heading', { name: 'Progression' })).toBeVisible();

  await page.getByLabel('Default progression').selectOption('double');
  await page.getByLabel('Rep range bottom').fill('8');
  await page.getByLabel('Rep range top').fill('12');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved at /)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Default progression')).toHaveValue('double');
  await expect(page.getByLabel('Rep range top')).toHaveValue('12');
});

// ---------------------------------------------------------------------------
// Settings → Data: the one action saves a dated archive (#947).
// ---------------------------------------------------------------------------

test('data section downloads the logbook as a dated zip', async ({ page }) => {
  await page.goto('/settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Data' })
    .click();
  await expect(page).toHaveURL(/\/settings\/data$/);
  await expect(page.getByRole('heading', { name: 'Data' })).toBeVisible();

  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  const download = await downloadStarted;

  expect(download.suggestedFilename()).toMatch(/^lifting-logbook-export-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(await download.failure()).toBeNull();
});

// ---------------------------------------------------------------------------
// Settings hub: the previously-orphaned /import wizard is reachable by link.
// ---------------------------------------------------------------------------

test('settings hub links to the Import wizard, which renders when reached', async ({ page }) => {
  await page.goto('/settings');

  await page.getByRole('link', { name: /Import data/i }).click();
  await expect(page).toHaveURL(/\/import$/);
  // A cold Next dev compile of the heavy import route can exceed the 5s default
  // on Windows; give the first render headroom (mirrors smoke.spec's 15s nav waits).
  await expect(page.getByRole('heading', { name: 'Import a file' })).toBeVisible({ timeout: 15_000 });
});
