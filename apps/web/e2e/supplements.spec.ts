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

  // Tab never reaches the page behind a modal dialog. Past the dialog's last control Chromium moves
  // focus to the browser itself (nothing focused in the document), so check every stop rather than
  // counting Tabs to one control, which breaks whenever the panel gains a button.
  let insideStops = 0;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return 'none';
      return document.querySelector('dialog[open]')?.contains(active) ? 'inside' : 'outside';
    });
    expect(where).not.toBe('outside');
    if (where === 'inside') insideStops++;
  }
  expect(insideStops).toBeGreaterThan(0);

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
  // The mockup's entry point: the Workout card's add starts on pre-workout, so a daily catalog
  // entry re-slots it, and the slot is the sixth filled field.
  await page.getByRole('button', { name: '+ Add to this day' }).click();
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

test('Edit stack: ticking a row and moving it with the bulk bar puts it in the new slot', async ({ page }) => {
  await page.goto('/supplements');
  const daily = page.getByRole('region', { name: 'Every day' });
  await expect(daily.getByRole('heading', { name: 'Morning' })).toBeVisible();
  await expect(daily.getByRole('heading', { name: 'Night' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Edit stack' }).click();
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Glycine' }).check();
  const bar = page.getByRole('region', { name: 'Selected items' });
  await expect(bar).toContainText('1 selected');

  await bar.getByRole('button', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move 1 row' });
  await dialog.getByLabel('Slot').selectOption('pm');
  await dialog.getByRole('button', { name: 'Move' }).click();

  await expect(dialog).toBeHidden();
  await expect(bar).toBeHidden();
  const night = daily.getByRole('heading', { name: 'Night' });
  await expect(night).toBeVisible();
  await expect(daily.getByRole('heading', { name: 'Morning' })).toHaveCount(0);
});

test('replaces an item into Pending: the new item is added and the replaced one moves to Pending', async ({ page }) => {
  await page.goto('/supplements');
  await page.getByRole('button', { name: /Nutricost Pre-X/ }).click();
  await page.getByRole('dialog', { name: 'Nutricost Pre-X' }).getByRole('button', { name: 'Replace with…' }).click();
  const form = page.getByRole('dialog', { name: 'Add supplement' });
  const group = form.getByRole('group', { name: 'Replace what you already take?' });
  await expect(group.getByText('You chose to replace this')).toBeVisible();
  await expect(group.getByRole('radio', { name: /Move them to Pending/ })).toBeChecked();

  await form.getByLabel('Name').fill('Pre-Y');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(form).toBeHidden();

  await expect(page.getByRole('button', { name: /Pre-Y/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Nutricost Pre-X/ })).toBeHidden();
  await page.getByRole('button', { name: /Pending · 2/ }).click();
  await expect(page.getByRole('button', { name: /Nutricost Pre-X/ })).toBeVisible();
});
