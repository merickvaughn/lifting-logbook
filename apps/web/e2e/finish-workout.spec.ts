import { test, expect, type Page } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

// Finish workout offers to set up a training max for a lift the workout logged without one
// (#1246, #1272). The mock reports workout 1's deadlift as missing a max.

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset?withWorkoutMissingMax=true`);
});

/**
 * Logs every planned set of workout 1 (squat, then deadlift), so Finish workout shows. Each set
 * gets a typed weight: with no max, the deadlift plans at 0.
 */
async function logEverySet(page: Page) {
  await page.goto('/macrocycle/1/workout/1');
  for (const lift of ['squat', 'deadlift']) {
    await page.getByRole('button', { name: `Go to ${lift}` }).click();
    const sets = page.getByRole('region', { name: 'Working sets' });
    const log = sets.getByRole('button', { name: 'Log' });
    for (let left = 3; left > 0; left--) {
      await expect(log).toHaveCount(left);
      await sets.getByLabel('Weight in lbs').first().fill('250');
      await log.first().click();
    }
    await expect(log).toHaveCount(0);
  }
}

test('asks about the lift without a max, and saves it with Set up all', async ({ page }) => {
  await logEverySet(page);
  await page.getByRole('button', { name: 'Finish workout' }).first().click();

  const dialog = page.getByRole('dialog', { name: 'New lifts need a training max' });
  const weight = dialog.getByLabel('Deadlift training max');
  await expect(weight).toBeFocused();
  await expect(weight).toHaveValue('250');
  await expect(dialog.getByText('Estimated from 250 lbs × 5 on 6 Jan 2025')).toBeVisible();

  const saved = page.waitForRequest((req) => req.method() === 'PATCH' && req.url().endsWith('/training-maxes'));
  await dialog.getByRole('button', { name: 'Set up all' }).click();

  expect((await saved).postDataJSON()).toEqual({ maxes: [{ lift: 'deadlift', weight: 250, unit: 'lbs' }] });
  await expect(page).toHaveURL(/\/macrocycle\/1$/);
});

test('leaves without saving on Not now', async ({ page }) => {
  await logEverySet(page);
  await page.getByRole('button', { name: 'Finish workout' }).first().click();

  await page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click();

  await expect(page).toHaveURL(/\/macrocycle\/1$/);
});
