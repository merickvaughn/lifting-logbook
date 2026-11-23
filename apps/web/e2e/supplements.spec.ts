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

test('Edit stack: Remove takes the ticked items off the page in one write', async ({ page }) => {
  const removes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/supplements/items/remove') removes.push(r.postData() ?? '');
  });
  await page.goto('/supplements');
  await page.getByRole('button', { name: 'Edit stack' }).click();
  await page.getByRole('checkbox', { name: 'Select Glycine' }).check();
  await page.getByRole('checkbox', { name: /^Select Nutricost Pre-X/ }).check();
  const bar = page.getByRole('region', { name: 'Selected items' });
  await bar.getByRole('button', { name: 'Remove' }).click();
  await bar.getByRole('button', { name: 'Tap again to remove 2 items' }).click();

  await expect(bar).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Select Glycine' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /^Select Nutricost Pre-X/ })).toHaveCount(0);
  expect(removes).toHaveLength(1);
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

test('History: restores a removed item, which returns to the stack', async ({ page }) => {
  await page.goto('/supplements');
  await page.getByRole('button', { name: 'Edit stack' }).click();
  await page.getByRole('checkbox', { name: 'Select Glycine' }).check();
  const bar = page.getByRole('region', { name: 'Selected items' });
  // The first tap asks, the second removes.
  await bar.getByRole('button', { name: 'Remove' }).click();
  await bar.getByRole('button', { name: /Tap again to remove/ }).click();
  await expect(page.getByRole('checkbox', { name: 'Select Glycine' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Done' }).click();

  const history = page.getByRole('button', { name: 'History' });
  await history.click();
  const dialog = page.getByRole('dialog', { name: 'Supplement history' });
  const onThen = dialog.getByRole('region', { name: 'What was I on?' }).getByRole('listitem');
  const changes = dialog.getByRole('region', { name: 'Changes' }).getByRole('listitem');
  await expect(onThen.filter({ hasText: /^Glycine — / })).toHaveCount(0);
  const removed = changes.filter({ hasText: 'Removed Glycine' });
  await removed.getByRole('button', { name: 'Restore Glycine' }).click();

  await expect(dialog.getByTestId('history-announcement')).toHaveText('Restored Glycine.');
  await expect(changes.first()).toContainText('Restored Glycine');
  await expect(dialog.getByRole('button', { name: 'Restore Glycine' })).toHaveCount(0);
  // Today's stack, read again, has it back.
  await expect(onThen.filter({ hasText: /^Glycine — 3 g · Morning$/ })).toHaveCount(1);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(history).toBeFocused();
  await expect(page.getByRole('button', { name: /^Glycine/ })).toBeVisible();
});

test('Import from Google Sheets: reviewed rows are added, focus returns to Import, and History notes the import', async ({ page }) => {
  await page.goto('/supplements');
  const importButton = page.getByRole('button', { name: 'Import from Google Sheets' });
  await importButton.click();
  const dialog = page.getByRole('dialog', { name: 'Import from Google Sheets' });
  await dialog.getByLabel('Google Sheets link').fill('https://docs.google.com/spreadsheets/d/abc/edit');
  await dialog.getByRole('button', { name: 'Read sheet' }).click();

  await expect(dialog.getByRole('heading', { name: 'Pick a tab' })).toBeFocused();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Supplements' })).toContainText('3 rows');
  await dialog.getByRole('button', { name: 'Supplements' }).click();

  await expect(dialog.getByRole('heading', { name: 'Review rows' })).toBeFocused();
  await expect(dialog.getByLabel('Melatonin (row 2)')).toHaveValue('active');
  await dialog.getByLabel('Nitrates (row 4)').selectOption('skip');
  await dialog.getByRole('button', { name: 'Import 2 items' }).click();

  await expect(dialog).toBeHidden();
  await expect(importButton).toBeFocused();
  await expect(page.getByTestId('supp-announcement')).toHaveText('Imported 2 items.');
  const daily = page.getByRole('region', { name: 'Every day' });
  await expect(daily.getByRole('button', { name: /^Melatonin/ })).toBeVisible();
  await expect(daily.getByRole('button', { name: /^Iron/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Nitrates/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('dialog', { name: 'Supplement history' });
  const added = history.getByRole('region', { name: 'Changes' }).getByRole('listitem').filter({ hasText: 'Added Melatonin' });
  await expect(added).toContainText('Imported from Supplements');
});

test('History: a Lift History link opens it at the date, which before the log starts says so', async ({ page }) => {
  await page.goto('/supplements?history=2026-11-01');
  const dialog = page.getByRole('dialog', { name: 'Supplement history' });
  await expect(dialog.getByLabel('Date')).toHaveValue('2026-11-01');
  await expect(dialog.getByText('0 items active at the end of that day. History starts on Nov 18, 2026.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(/\/supplements$/);
  await expect(page.getByRole('button', { name: 'History' })).toBeFocused();
});
