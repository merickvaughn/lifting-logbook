import { test, expect, type Page } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

// The calendar sends the browser's calendar day as `today` (ADR-039 §5). Pinning the
// browser clock to a day inside the mock macrocycle (which starts 2025-01-06) keeps both
// the program row and the seeded focus blocks in view, and puts the January Biceps block
// eight days from its end, inside the renew prompt's window.
const TODAY = '2025-01-23';

// Warm the route once so its cold on-demand compile in Next dev can't eat the first
// test's timeout (the CLAUDE.md pattern, from import.spec.ts / #698).
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await page.goto('/calendar', { timeout: 90_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible({ timeout: 90_000 });
  await page.close();
});

test.beforeEach(async ({ request, page }) => {
  await request.get(`${MOCK_API}/__reset?withFocusBlocks=${TODAY}`);
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00`));
});

async function openCalendar(page: Page) {
  await page.goto('/calendar');
  // Generous first wait: Next dev compiles the route on demand on the first visit.
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Shoulders focus block, Q1 2025, active' })).toBeVisible();
}

test('the app nav links to the calendar', async ({ page }) => {
  await page.goto('/glossary');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible({ timeout: 90_000 });
});

test('shows the program phases and a lane per focus series', async ({ page }) => {
  await openCalendar(page);
  await expect(page.getByRole('button', { name: 'Mesocycle 1, Jan 6 – Jan 10, 2025' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back focus block, Q2 2025, queued' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Biceps focus block, January 2025, active' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Biceps focus block, December 2024, ended' })).toBeVisible();
  await expect(page.getByText('Today', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: /Mesocycle 1/ }).click();
  await expect(page.getByRole('region', { name: 'Selected program phase' })).toContainText('Jan 6 – Jan 10, 2025 · 1 week');
});

test('an active focus block shows its progress and settings', async ({ page }) => {
  await openCalendar(page);
  await page.getByRole('button', { name: 'Shoulders focus block, Q1 2025, active' }).click();
  const card = page.getByRole('region', { name: 'Selected focus block' });
  await expect(card).toContainText('Week 4 of 13');
  await expect(card).toContainText('Lateral Raise, Face Pull');
  await expect(card).toContainText('Auto-roll to Back');
  await expect(card.getByRole('link', { name: 'Edit in Programs' })).toHaveAttribute(
    'href',
    '/programs/focus?block=fb-shoulders',
  );
});

test('renewing a focus block that is ending queues the next one', async ({ page }) => {
  await openCalendar(page);
  await page.getByRole('button', { name: 'Biceps focus block, January 2025, active' }).click();
  const card = page.getByRole('region', { name: 'Selected focus block' });
  await expect(card).toContainText('Biceps (January 2025) ends in 8 days');
  await card.getByRole('button', { name: 'Renew for February' }).click();
  await expect(page.getByRole('button', { name: 'Biceps focus block, February 2025, queued' })).toBeVisible();
  // A queued successor answers the prompt.
  await expect(card).not.toContainText('ends in 8 days');
});

test('an ended focus block shows its summary', async ({ page }) => {
  await openCalendar(page);
  await page.getByRole('button', { name: 'Biceps focus block, December 2024, ended' }).click();
  const card = page.getByRole('region', { name: 'Selected focus block' });
  await expect(card).toContainText('18,340 lbs');
  await expect(card).toContainText('Hammer Curl: 40 lbs × 12 (+5 lbs)');
});

test('cancelling a queued auto-roll removes it and stops the roll', async ({ page }) => {
  await openCalendar(page);
  await page.getByRole('button', { name: 'Back focus block, Q2 2025, queued' }).click();
  const card = page.getByRole('region', { name: 'Selected focus block' });
  await expect(card).toContainText('Auto-rolls from Shoulders when it ends.');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: /Back focus block/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Shoulders focus block, Q1 2025, active' }).click();
  await expect(page.getByRole('region', { name: 'Selected focus block' })).toContainText('Prompt me');
});
