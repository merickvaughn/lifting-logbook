import { test, expect, type Locator, type Page } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

const DETAIL = '/macrocycle/1/workout/1/detail';

// Focus work on workout details (#1058). The mock plans one Shoulders focus block of
// three lifts (nine sets) against a six-set daily guide, so the advice shows until a
// lift is trimmed.

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset?withFocus=true`);
});

function headings(page: Page) {
  return page.getByRole('heading', { level: 2 });
}

/**
 * Clicks `button` until `landed` shows. The focus controls are server-rendered, so
 * a click that arrives before hydration finds no handler and is lost; a cold
 * `next dev` compile on Windows makes that window wide enough to hit.
 *
 * Only for clicks that are idempotent once they land, since a slow round trip can
 * trigger a retry after the first click took effect. Every action used here is:
 * placement radios, Keep everything / Show suggestion, Undo, Reset order, and Trim,
 * which ignores a lift already trimmed and is disabled while a save is in flight.
 */
async function clickOnceHydrated(button: Locator, landed: Locator) {
  await expect(async () => {
    if (await button.isVisible()) await button.click();
    await expect(landed).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

test('shows focus work after the planned lifts, with the summary against the guide', async ({ page }) => {
  await page.goto(DETAIL);

  await expect(headings(page)).toHaveText(['Workout Summary', 'Planned', 'Focus work']);
  await expect(page.getByText('9 sets / 6 guide')).toBeVisible();
  const focus = page.getByRole('region', { name: 'Focus work' });
  await expect(focus.getByRole('button', { name: /Lateral Raise/ })).toBeVisible();
  await expect(focus.getByRole('button', { name: /Arnold Press/ })).toBeVisible();
});

test('trims the suggested lift, then undoes the trim', async ({ page }) => {
  await page.goto(DETAIL);

  const advice = page.getByRole('region', { name: 'Focus guide advice' });
  await expect(advice).toContainText('trimming Arnold Press brings today to 6 sets');
  await clickOnceHydrated(advice.getByRole('button', { name: 'Trim Arnold Press' }), page.getByText('6 sets / 6 guide'));

  await expect(advice).toBeHidden();
  await expect(page.getByText(/Arnold Press\s+trimmed for today/)).toBeVisible();

  // Persisted: still trimmed after a reload.
  await page.reload();
  await expect(page.getByText('6 sets / 6 guide')).toBeVisible();

  await clickOnceHydrated(page.getByRole('button', { name: 'Undo' }), page.getByText('9 sets / 6 guide'));
  await expect(page.getByRole('region', { name: 'Focus guide advice' })).toBeVisible();
});

test('keeps everything when asked, and remembers it', async ({ page }) => {
  await page.goto(DETAIL);

  await clickOnceHydrated(
    page.getByRole('button', { name: 'Keep everything' }),
    page.getByText(/Over the guide; keeping everything/),
  );

  await page.reload();
  await expect(page.getByRole('region', { name: 'Focus guide advice' })).toBeHidden();
  await clickOnceHydrated(
    page.getByRole('button', { name: 'Show suggestion' }),
    page.getByRole('region', { name: 'Focus guide advice' }),
  );
});

test('places focus work before, then interleaves and reorders it from the keyboard', async ({ page }) => {
  await page.goto(DETAIL);

  await clickOnceHydrated(
    page.getByRole('radio', { name: 'Before' }),
    page.getByRole('radio', { name: 'Before', checked: true }),
  );
  await expect(headings(page)).toHaveText(['Workout Summary', 'Focus work', 'Planned']);

  await page.getByRole('radio', { name: 'Interleave' }).click();
  await expect(headings(page)).toHaveText(['Workout Summary', 'Today’s order', 'Focus controls for today']);

  const order = page.getByRole('region', { name: 'Today’s order' });
  const firstRow = order.getByRole('listitem').first();
  await expect(firstRow).not.toContainText('Lateral Raise');

  const moveUp = order.getByRole('button', { name: 'Move Lateral Raise up' });
  await moveUp.focus();
  await page.keyboard.press('Enter');
  await expect(firstRow).toContainText('Lateral Raise');

  // Placement and order are saved for this workout.
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Interleave' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('region', { name: 'Today’s order' }).getByRole('listitem').first()).toContainText(
    'Lateral Raise',
  );

  const reloadedFirstRow = page.getByRole('region', { name: 'Today’s order' }).getByRole('listitem').first();
  await clickOnceHydrated(
    page.getByRole('button', { name: 'Reset order' }),
    reloadedFirstRow.filter({ hasNotText: 'Lateral Raise' }),
  );
});

test('the untimed logging page lists focus lifts and logs them as lift records (#1060)', async ({ page }) => {
  await page.goto('/macrocycle/1/workout/1');

  // The overview lists the planned lifts, then the focus lifts, tagged with their area.
  await page.getByRole('button', { name: 'Switch to overview' }).click();
  const rows = page.getByRole('listitem');
  await expect(rows.filter({ hasText: 'Lateral Raise' })).toContainText('Focus · Shoulders');
  const names = await page.locator('[class*="overviewLiftName"]').allTextContents();
  expect(names.slice(-3)).toEqual(['Lateral Raise', 'Face Pull', 'Arnold Press']);

  await rows.filter({ hasText: 'Lateral Raise' }).getByRole('button', { name: 'Go to' }).click();
  await expect(page.getByText('Focus work · Shoulders · 3 × 10–12')).toBeVisible();

  // A focus set is an ordinary lift record against this workout, prefilled from its prescription.
  const posted = page.waitForRequest(
    (req) => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/lift-records'),
  );
  await expect(page.getByLabel('Weight in lbs').first()).toHaveValue('25');
  await page.getByRole('button', { name: 'Log' }).first().click();
  expect((await posted).postDataJSON()).toMatchObject({
    workoutNum: 1,
    lift: 'Lateral Raise',
    setNum: 1,
    weight: 25,
    reps: 12,
  });
});

test('falls back to the planned lifts with a notice when focus work fails to load', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset?withFocusError=true`);
  await page.goto(DETAIL);

  await expect(page.getByText('Focus work couldn’t load, so only the planned lifts are shown.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Planned Lifts' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Focus work' })).toHaveCount(0);
});
