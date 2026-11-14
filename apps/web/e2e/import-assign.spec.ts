import { test, expect, type Page } from '@playwright/test';

// The import wizard's Assign step (#1256), against the mock's withAssign file: 30 macrocycles
// three weeks apart, a one-lift session in each of the first 20 breaks, and the first
// macrocycle with no status. Host pinned to 127.0.0.1 and the port injected per run (#741, #746).
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

// /import compiles on demand in Next dev, and a cold compile on Windows can outlast the
// default timeouts, so warm it once (#698).
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await page.goto('/import', { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Import a file' })).toBeVisible({ timeout: 90_000 });
  await page.close();
});

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset?withAssign=true`);
});

/** To the Assign step, importing into `program` (by its name) when given, else the active one. */
async function toAssign(page: Page, program?: string) {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import a file' })).toBeVisible({ timeout: 15_000 });
  if (program) await page.getByLabel('Program').selectOption({ label: program });
  await page.getByLabel('CSV file').setInputFiles({
    name: 'history.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Date,Lift,Set #,Weight,Reps\n2024-01-01,Squat,1,200,5'),
  });
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByText('Lift History')).toBeVisible();
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await next.click(); // → Map columns
  await next.click(); // → Review
  await next.click(); // → Assign
  await expect(page.getByRole('heading', { name: 'Assign your history to macrocycles' })).toBeVisible();
}

test('Assign: a boundary moves by keyboard alone, keeping focus, and status is written out', async ({ page }) => {
  await toAssign(page);

  // Each control is named for its stretch, so the same press twice is told apart by name.
  const later = page.getByRole('button', { name: 'Start RPT from Jan 22, 2024 one workout later' });
  await later.focus();
  await page.keyboard.press('Enter');
  const moved = page.getByRole('button', { name: 'Start RPT from Jan 24, 2024 one workout later' });
  await expect(moved).toBeFocused();
  await page.keyboard.press('Space');
  const movedAgain = page.getByRole('button', { name: 'Start RPT from Jan 26, 2024 one workout later' });
  await expect(movedAgain).toBeFocused();
  // One session left, so the control says it can't go further, and keeps focus.
  await expect(movedAgain).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(movedAgain).toBeFocused();

  // Other controls carry their stretch's name too.
  await expect(page.getByRole('button', { name: 'Join RPT from Jan 26, 2024 with the macrocycle before it' })).toBeVisible();
  await expect(page.getByLabel('Status for RPT from Jan 1, 2024')).toBeVisible();

  // Status is text as well as color: the open stretch needs one, the settled ones say theirs.
  await expect(page.getByRole('region', { name: 'RPT from Jan 1, 2024' })).toContainText('Status needed');
  await expect(page.getByTestId('assign-settled').first()).toContainText('Unfinished');
});

/** Commits the file through Assign into `program` when given, else the active one. */
async function commitThroughAssign(page: Page, program?: string) {
  await toAssign(page, program);
  await page.getByRole('button', { name: 'Keep every break: file the 20 one-lift workouts with the macrocycle before each' }).click();
  await page.getByLabel('Status for RPT from Jan 1, 2024').selectOption('completed');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preview changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Commit import' }).click();
  await expect(page.getByText('Import complete')).toBeVisible();
}

/** Commits the file through Assign, then leaves the wizard for the past-macrocycles list. */
async function importThenOpenHistory(page: Page) {
  await commitThroughAssign(page);

  // Leave the wizard: its own Undo is gone with it.
  await page.goto('/history');
  await page.getByRole('tab', { name: 'Macrocycles' }).click();
  const imported = page.getByRole('row').filter({ hasText: '2024-01-' });
  await expect(imported).toHaveCount(2);
  return imported;
}

// #1300: History shows any of the lifter's programs, so an import into one that isn't active
// can be undone there too.
test('Assign: an import into a program that isn’t active is undone from History', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset?withAssign=true&withCustomProgram=true`);
  await commitThroughAssign(page, 'My Custom Program');

  // History opens on the active program, which the import didn't touch.
  await page.goto('/history');
  await page.getByRole('tab', { name: 'Macrocycles' }).click();
  const imported = page.getByRole('row').filter({ hasText: '2024-01-' });
  await expect(page.getByRole('row').filter({ hasText: '2024-09-02' })).toHaveCount(1);
  await expect(imported).toHaveCount(0);

  await page.getByLabel('Program').selectOption({ label: 'My Custom Program' });
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page).toHaveURL(/[?&]program=cust-1/);
  await expect(page.getByText('We couldn’t load your latest history just now.', { exact: false })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Macrocycles' }).click();
  await expect(imported).toHaveCount(2);

  await page.getByRole('button', { name: 'Undo import of macrocycle 2' }).click();
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  await expect(imported).toHaveCount(0);
  await expect(page.getByText(/^Undo complete: \d+ restored/)).toBeFocused();
});

// #1257: an import is undone from the past-macrocycles list once the wizard is gone.
test('Assign: an import is undone later from the past-macrocycles list', async ({ page }) => {
  const imported = await importThenOpenHistory(page);

  await page.getByRole('button', { name: 'Undo import of macrocycle 2' }).click();
  await expect(page.getByText(/Every set it added goes/)).toBeVisible();
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();

  // Both of its macrocycles go, the outcome stays, and the earlier history numbers from 1 again.
  await expect(imported).toHaveCount(0);
  await expect(page.getByText(/^Undo complete: \d+ restored/)).toBeFocused();
  await expect(page.getByRole('row').filter({ hasText: '2024-09-02' }).getByRole('cell').first()).toHaveText('1');
});

// The confirm button is disabled while the undo runs, which in a browser drops its focus.
test('Assign: a failed undo from the list says why and keeps focus on its confirm', async ({ page }) => {
  const imported = await importThenOpenHistory(page);
  const message = 'today must be within a day of the server date. Check your device clock.';
  await page.route('**/import/*/undo*', (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ statusCode: 400, message }) }),
  );

  await page.getByRole('button', { name: 'Undo import of macrocycle 2' }).click();
  const confirm = page.getByRole('button', { name: 'Undo import', exact: true });
  await confirm.click();

  await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
  await expect(confirm).toBeFocused();
  await expect(imported).toHaveCount(2);
});

test('Assign: a long file stays workable at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await toAssign(page);

  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  // The 29 settled macrocycles are one line each.
  const settled = page.getByTestId('assign-settled');
  await expect(settled).toHaveCount(29);
  for (const row of await settled.all()) {
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeLessThan(56);
  }

  // One action keeps every break, filing each lone session with the macrocycle before it.
  await page.getByRole('button', { name: 'Keep every break: file the 20 one-lift workouts with the macrocycle before each' }).click();
  const earlier = page.getByRole('button', { name: /^File the .* workout with the earlier macrocycle$/ });
  await expect(earlier).toHaveCount(20);
  for (const button of await earlier.all()) {
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  await page.getByLabel('Status for RPT from Jan 1, 2024').selectOption('completed');
  await expect(page.getByTestId('assign-decisions')).toHaveText('Nothing left to decide. Continue to Preview.');
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preview changes' })).toBeVisible();
});
