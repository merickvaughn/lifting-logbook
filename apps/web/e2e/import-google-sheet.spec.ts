import { test, expect, type APIRequestContext } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost) and port injected per run — see
// import.spec.ts (#741, #746).
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/15s6_k614x9FzQtHxQDxh82CjDKYqHaS-VZtmS0he-8Q/edit';

// Warm the on-demand-compiled /import route once, as import.spec.ts does (#698).
test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await page.goto('/import', { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Import a file' })).toBeVisible({ timeout: 90_000 });
  await page.close();
});

const reset = (request: APIRequestContext, extra = '') =>
  request.get(`${MOCK_API}/__reset?withCustomProgram=true&withGoogleSheet=true${extra}`);

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test('Google Sheets import: fetch workbook → preview tabs → commit each tab (#1111)', async ({ page }) => {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import a file' })).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Google Sheets', { exact: true }).check();
  await page.getByLabel('Google Sheets link').fill(SHEET_URL);
  await page.getByRole('button', { name: 'Fetch workbook' }).click();

  // Workbook overview: both data tabs pre-selected and previewed; the table-of-contents tab is not importable.
  await expect(page.getByRole('heading', { name: 'Choose tabs to import' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'LIFT_RECORDS', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'TRAINING_MAXES', exact: true })).toBeChecked();
  await expect(page.getByText('2 new · 0 updated · 0 skipped')).toBeVisible();
  await expect(page.getByText('2 new · 1 updated · 0 skipped')).toBeVisible();
  await expect(page.getByText('1 tab not importable')).toBeVisible();

  // Tab 1: LIFT_RECORDS.
  await page.getByRole('button', { name: 'Import 2 tabs' }).click();
  await expect(page.getByText('Tab 1 of 2: LIFT_RECORDS')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Map columns' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // → Review
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // → Preview
  await page.getByRole('button', { name: 'Commit import' }).click();
  await expect(page.getByText('Import complete')).toBeVisible();

  // Tab 2: TRAINING_MAXES.
  await page.getByRole('button', { name: 'Next tab: TRAINING_MAXES' }).click();
  await expect(page.getByText('Tab 2 of 2: TRAINING_MAXES')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // → Review
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // → Preview
  await page.getByRole('button', { name: 'Commit import' }).click();
  await expect(page.getByText('Import complete')).toBeVisible();

  // The first tab's result stays listed, with its own undo.
  await expect(page.getByRole('button', { name: 'Undo LIFT_RECORDS' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo LIFT_RECORDS' }).click();
  await expect(page.getByText('Undone (2 restored).')).toBeVisible();
});

test('Google Sheets import: a private sheet shows sharing instructions (#1111)', async ({ page, request }) => {
  await reset(request, '&withPrivateSheet=true');
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import a file' })).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Google Sheets', { exact: true }).check();
  await page.getByLabel('Google Sheets link').fill(SHEET_URL);
  await page.getByRole('button', { name: 'Fetch workbook' }).click();

  // Scoped to <main>: in dev, Next's error overlay repeats the logged client error.
  await expect(page.getByRole('main').getByText(/This sheet is not shared\..*Anyone with the link/)).toBeVisible();
});

test('Google Sheets import: a link that is not a Google Sheet is rejected (#1111)', async ({ page }) => {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import a file' })).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Google Sheets', { exact: true }).check();
  await page.getByLabel('Google Sheets link').fill('https://example.com/sheet');
  await page.getByRole('button', { name: 'Fetch workbook' }).click();

  await expect(page.getByRole('main').getByText('Only Google Sheets links (docs.google.com) can be imported.')).toBeVisible();
});
