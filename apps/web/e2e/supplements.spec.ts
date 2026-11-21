import { test, expect } from '@playwright/test';

const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset`);
});

test('supplements page shows the lift day, and its detail panel opens, traps focus and closes on Esc', async ({ page }) => {
  await page.goto('/supplements');
  await expect(page.getByRole('heading', { name: 'What I’m on' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Supplements' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workout · Lift day' })).toBeVisible();
  await expect(page.getByText('Nothing intra-workout')).toBeVisible();
  // The late-stimulant advisory is a sentence on the row, not only a tint.
  await expect(page.getByText('Stimulant at 4:30 PM, after your 3:00 PM caffeine cutoff')).toBeVisible();

  const row = page.getByRole('button', { name: /Nutricost Pre-X/ });
  await row.click();
  const dialog = page.getByRole('dialog', { name: 'Nutricost Pre-X' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Worth a look' })).toBeVisible();

  // Tab never leaves a modal dialog.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();
});

test('supplements page switches to the rest day', async ({ page }) => {
  await page.goto('/supplements');
  await page.getByRole('button', { name: 'Rest day' }).click();
  await expect(page.getByText('Nothing workout-specific on rest days.')).toBeVisible();
  await expect(page.getByText('None on this day')).toBeVisible();
});

test('adds a supplement from the shared catalog: autofill, suggested fields, and the new row', async ({ page }) => {
  await page.goto('/supplements');
  await page.getByRole('button', { name: '+ Add daily item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add supplement' });
  await expect(dialog.getByLabel('Name')).toBeFocused();

  await dialog.getByLabel('Name').fill('creatine');
  await expect(dialog.getByRole('status')).toContainText('Filled 6 fields from the shared catalog');
  await expect(dialog.getByLabel(/^Key compound/)).toHaveValue('Creatine monohydrate');
  await expect(dialog.getByLabel(/^Amount/)).toHaveValue('5 g');
  await expect(dialog.getByLabel('Link 1 label')).toHaveValue('Search Amazon');
  await expect(dialog.getByText('SUGGESTED')).toHaveCount(6);

  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('button', { name: /creatine/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('5 g');
});

test('a name that is not in the shared catalog says so, and fills nothing', async ({ page }) => {
  await page.goto('/supplements');
  await page.getByRole('button', { name: '+ Add daily item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add supplement' });
  await dialog.getByLabel('Name').fill('zzz');
  await expect(dialog.getByText('Not in the shared catalog.')).toBeVisible();
  await expect(dialog.getByLabel(/^Key compound/)).toHaveValue('');
});
