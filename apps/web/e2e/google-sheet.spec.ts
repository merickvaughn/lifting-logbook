import { test, expect } from '@playwright/test';

// Link and unlink a Google Sheet in Settings > Data (#1433). The e2e mock stands in for the API,
// and the spec stands in for Google: the mock's authorize URL points at accounts.google.test,
// which the browser is sent to and which redirects back to the callback route.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';
const GOOGLE = 'https://accounts.google.test/**';

const reset = (request: import('@playwright/test').APIRequestContext, query = '') =>
  request.get(`${MOCK_API}/__reset${query}`);

test('links a Google Sheet through Google and the callback route, then unlinks it', async ({ page, request, baseURL }) => {
  await reset(request);
  await page.route(GOOGLE, (route) =>
    route.fulfill({
      status: 302,
      headers: { location: `${baseURL}/settings/data/google-sheet/callback?code=mock-code&state=mock-state` },
    }),
  );
  await page.goto('/settings/data');

  await page.getByRole('button', { name: 'Link a Google Sheet' }).click();

  await expect(page.getByRole('link', { name: 'Open your sheet' })).toHaveAttribute('href', /docs\.google\.com\/spreadsheets/);
  await expect(page.getByText('Your Google Sheet is linked.')).toBeVisible();
  // The code and state are gone from the address.
  await expect(page).toHaveURL(/\/settings\/data$/);

  await page.getByRole('button', { name: 'Unlink' }).click();
  await expect(page.getByRole('button', { name: 'Link a Google Sheet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open your sheet' })).toHaveCount(0);
});

test('says so when Google refuses, and the section stays usable', async ({ page, request, baseURL }) => {
  await reset(request);
  await page.route(GOOGLE, (route) =>
    route.fulfill({
      status: 302,
      headers: { location: `${baseURL}/settings/data/google-sheet/callback?error=access_denied&state=mock-state` },
    }),
  );
  await page.goto('/settings/data');

  await page.getByRole('button', { name: 'Link a Google Sheet' }).click();

  await expect(page.getByText('Google access wasn’t granted, so nothing was linked.')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/data$/);
  await expect(page.getByRole('button', { name: 'Link a Google Sheet' })).toBeVisible();
});

test('isn’t shown when the API has no Google client', async ({ page, request }) => {
  await reset(request, '?googleSheet=unconfigured');
  await page.goto('/settings/data');

  await expect(page.getByRole('heading', { name: 'Clear training data' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Google Sheet' })).toHaveCount(0);
});

test('Sync now enqueues a run, and a failed last sync shows until it succeeds', async ({ page, request }) => {
  await reset(request, '?googleSheet=failed');
  await page.goto('/settings/data');

  await expect(page.getByText('Last sync failed.')).toBeVisible();
  await page.getByRole('button', { name: 'Sync now' }).click();

  await expect(page.getByText('Sync started.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Google Sheet' })).toBeFocused();
  await page.reload();
  await expect(page.getByText('Last sync failed.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible();
});
