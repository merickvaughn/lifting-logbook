import { test, expect } from '@playwright/test';

// Mock API base. Host pinned to 127.0.0.1 (not localhost): IPv4-only dev servers + Windows
// localhost -> ::1 (#741). The PORT is injected per-run by playwright.config.ts so concurrent
// worktree runs don't collide (#746); the literal is a fallback for a bare `playwright test`.
const MOCK_API = process.env.PLAYWRIGHT_MOCK_API_URL ?? 'http://127.0.0.1:3004';

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK_API}/__reset`);
});

// ---------------------------------------------------------------------------
// 1. Home page renders
// ---------------------------------------------------------------------------

test('home page renders with primary navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Lifting Logbook' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Current Macrocycle/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Get Started/i })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. No active macrocycle → redirect to onboarding
// ---------------------------------------------------------------------------

test('no active macrocycle redirects to onboarding', async ({ page, request }) => {
  await request.get(`${MOCK_API}/__reset?noCurrentMacrocycle=true`);
  await page.goto('/macrocycle');
  await expect(page).toHaveURL(/\/onboarding/);
});

// ---------------------------------------------------------------------------
// 3. Onboarding flow → lands on macrocycle dashboard
// ---------------------------------------------------------------------------

test('onboarding: choose program → enter lifts → confirm → lands on macrocycle', async ({ page, request }) => {
  // The onboarding guard redirects to /macrocycle/<N> when a macrocycle already exists,
  // so this test must start from a no-macrocycle state.
  await request.get(`${MOCK_API}/__reset?noCurrentMacrocycle=true`);
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Get Started' })).toBeVisible();

  // Step 1: Choose Method — pick "Enter training maxes" (weight-only, no reps needed)
  await page.getByRole('button', { name: 'Enter training maxes' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 2: Choose Program — switch to Intermediate tab, select RPT
  await page.getByRole('tab', { name: 'Intermediate' }).click();
  await page.getByRole('button', { name: /Reverse Pyramid Training/i }).click();

  // Detail view — confirm program selection (seeds RPT lifts into the next step)
  await page.getByRole('button', { name: 'Choose This Program' }).click();

  // Step 3: Enter Lifts — RPT's 9 lifts are pre-seeded; enter a TM for each
  const rptLifts = [
    'Bench Press', 'Barbell Row', 'Overhead Press',
    'Squat', 'Romanian Deadlift', 'Calf Raises',
    'Deadlift', 'Weighted Pull-ups', 'Dips',
  ];
  for (const lift of rptLifts) {
    await page.getByLabel(`${lift} weight`, { exact: true }).fill('225');
  }
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 4: Confirm Maxes — submit to create the first macrocycle
  await page.getByRole('button', { name: 'Start My Program' }).click();

  // Should land on the macrocycle dashboard
  await expect(page).toHaveURL(/\/macrocycle\/1/, { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// 4. Macrocycle dashboard renders workouts
// ---------------------------------------------------------------------------

test('macrocycle dashboard renders workout grid', async ({ page }) => {
  await page.goto('/macrocycle');
  await expect(page).toHaveURL(/\/macrocycle\/1/);
  await expect(page.getByRole('heading', { name: 'Macrocycle 1' })).toBeVisible();
  // The grid renders one collapsible section per program week (issue #740). The mock
  // macrocycle's dates are all in the past, so the current-week heuristic expands a later
  // week and Week 1 starts collapsed — expand it, then assert its workout entry shows.
  await page.getByRole('button', { name: 'Week 1', exact: true }).click();
  await expect(page.locator('text=2025-01-06').first()).toBeVisible();

  // The screen is discoverably labeled as the dashboard.
  await expect(page.getByText('Dashboard', { exact: true })).toBeVisible();

  // Macrocycle progress bar renders with an "N of M workouts" readout and an
  // accessible progressbar role. The regex keeps this robust to whatever
  // completed/total counts the mock fixture produces.
  await expect(page.getByText(/\d+ of \d+ workouts/)).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: 'Macrocycle progress' }),
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4a. Glossary: a heading's "?" link lands on the term's entry
// ---------------------------------------------------------------------------

test('dashboard glossary link opens the macrocycle entry', async ({ page }) => {
  await page.goto('/macrocycle/1');
  await page.getByRole('link', { name: 'What does “Macrocycle” mean?' }).click();
  await expect(page).toHaveURL(/\/glossary#macrocycle$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Glossary' })).toBeVisible();
  await expect(page.locator('#macrocycle')).toContainText('One complete run through a program');
  // The primary nav reaches the same page.
  await expect(page.getByRole('link', { name: 'Glossary' })).toHaveAttribute('href', '/glossary');
});

// ---------------------------------------------------------------------------
// 4b. Program page: "Edit Program" reads as disabled-with-reason
// ---------------------------------------------------------------------------

test('macrocycle program page marks Edit Program as coming soon', async ({ page }) => {
  await page.goto('/macrocycle/1/program');

  // The action is not built yet: the button is aria-disabled (still focusable, so
  // the reason is reachable by AT) with a visible "Coming soon" affordance beside
  // it — not a bare `disabled` button whose title tooltip a keyboard user cannot reach.
  const editButton = page.getByRole('button', { name: 'Edit Program' });
  await expect(editButton).toBeVisible();
  await expect(editButton).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('Coming soon')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 5. Workout logger renders sets/reps and accepts a log submission
// ---------------------------------------------------------------------------

test('workout logger renders planned sets and accepts a submission', async ({ page }) => {
  await page.goto('/macrocycle/1/workout/1');

  // Working sets section must be present — confirms the workout loaded and rendered
  await expect(page.getByRole('region', { name: 'Working sets' })).toBeVisible();

  // Working set inputs have known aria-labels; require them to be present
  const weightInput = page.getByLabel('Weight in lbs').first();
  await expect(weightInput).toBeVisible();
  await weightInput.fill('255');

  const logBtn = page.getByRole('button', { name: 'Log' }).first();
  await expect(logBtn).toBeEnabled();
  await logBtn.click();

  // Working sets section still present after logging (no unwanted navigation)
  await expect(page.getByRole('region', { name: 'Working sets' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. Training maxes settings: values load, update reflected in history
// ---------------------------------------------------------------------------

test('training maxes page loads values and submits update', async ({ page }) => {
  await page.goto('/settings/training-maxes');

  // The page should show the current TMs from the mock (squat: 300 lbs)
  const squatInput = page.getByLabel('squat training max');
  await expect(squatInput).toBeVisible();
  await expect(squatInput).toHaveValue('300');

  // Update squat TM
  await squatInput.fill('315');
  const saveBtn = page.getByRole('button', { name: 'Save' });
  await expect(saveBtn).toBeVisible();
  await saveBtn.click();

  // History section should be present
  await expect(page.locator('text=2025-01-01').first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 7. History page: both tabs render with data
// ---------------------------------------------------------------------------

test('history page tabs render lift history and TM timeline', async ({ page }) => {
  await page.goto('/history');

  // Lift History tab is active by default
  await expect(page.getByRole('tab', { name: 'Lift History' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'TM Timeline' })).toBeVisible();

  // Lift History shows records from mock — assert the squat cell in the table,
  // not the hidden <option> in the lift filter <select>
  await expect(page.getByRole('cell', { name: 'squat' }).first()).toBeVisible();

  // Switch to TM Timeline
  await page.getByRole('tab', { name: 'TM Timeline' }).click();
  // TM timeline groups entries by lift under an <h2> heading
  await expect(page.getByRole('heading', { name: 'bench-press' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 8. Programs page: catalog loads, switch dialog opens
// ---------------------------------------------------------------------------

test('programs page catalog loads and switch dialog can be opened', async ({ page }) => {
  await page.goto('/programs');

  await expect(page.getByRole('heading', { name: 'Programs' })).toBeVisible();

  // Multiple programs are available; click the first card's action button.
  await page.getByRole('button', { name: 'Choose This Program' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm Switch' })).toBeVisible();

  // Dismiss without switching
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// 9. Strength goals: create → appears in list, delete → removed
// ---------------------------------------------------------------------------

test('strength goals: create a goal and delete it', async ({ page }) => {
  await page.goto('/settings/strength-goals');

  // The page loads training maxes and renders goal cards per lift
  await expect(page.getByRole('heading', { name: 'Strength Goals' })).toBeVisible();
  await expect(page.locator('text=squat').first()).toBeVisible();

  // Switch to Absolute goal type for squat
  const absoluteBtn = page.getByRole('button', { name: /Absolute/i }).first();
  await absoluteBtn.click();

  // Fill in a target weight
  const targetInput = page.getByLabel(/Target weight for squat/i);
  await targetInput.fill('315');

  // Save the goal
  await page.getByRole('button', { name: /✓ Save/i }).first().click();

  // Wait for save to succeed — the Remove button should now be visible
  await expect(page.getByRole('button', { name: /✕ Remove/i }).first()).toBeVisible({ timeout: 5_000 });

  // Delete the goal
  await page.getByRole('button', { name: /✕ Remove/i }).first().click();

  // Remove button should disappear once deleted
  await expect(page.getByRole('button', { name: /✕ Remove/i })).toHaveCount(0, { timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// 10. Persistent app nav: present across screens, escapes the Programs page
// ---------------------------------------------------------------------------

test('primary nav persists and provides an escape route from Programs', async ({ page }) => {
  await page.goto('/programs');

  // The Programs page used to be a dead-end; the global nav now offers a way out.
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav).toBeVisible();

  await nav.getByRole('link', { name: 'History' }).click();
  await expect(page).toHaveURL(/\/history/);

  // The brand wordmark links back to the current macrocycle from anywhere.
  await page.getByRole('link', { name: 'Lifting Logbook' }).click();
  await expect(page).toHaveURL(/\/macrocycle\/1/);
});
