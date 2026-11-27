import { test, expect } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

// Logging a complex on its card (#1496). The mock plans the Bear complex (deadlift × 1,
// squat × 2) in workout 1 and lists the sets logged in it under the slot, as the API does.

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset?withComplex=true`);
});

test('logs two rounds of a complex, and shows them again on reload', async ({ page }) => {
  await page.goto('/macrocycle/1/workout/1');
  const card = page.getByRole('region', { name: 'Bear' });
  await expect(card.getByRole('heading', { level: 3, name: 'Bear' })).toBeVisible();

  await card.getByLabel('Weight (lbs) for Bear').fill('135');
  await card.getByRole('button', { name: 'Add a round of Bear' }).click();
  await card.getByRole('button', { name: 'Add a round of Bear' }).click();
  await card.getByLabel('Bear round 2 squat reps').fill('1');

  const saves: unknown[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/lift-records')) saves.push(req.postDataJSON());
  });
  await card.getByRole('button', { name: 'Save Bear rounds' }).click();
  const logged = card.getByRole('list', { name: 'Bear logged rounds' });
  await expect(logged.getByText('Round 2: deadlift × 1, squat × 1 at 135 lbs')).toBeVisible();
  expect(saves).toHaveLength(4);

  await page.reload();
  const reloaded = page.getByRole('region', { name: 'Bear' }).getByRole('list', { name: 'Bear logged rounds' });
  await expect(reloaded.getByText('Round 1: deadlift × 1, squat × 2 at 135 lbs')).toBeVisible();
  await expect(reloaded.getByText('Round 2: deadlift × 1, squat × 1 at 135 lbs')).toBeVisible();
});
