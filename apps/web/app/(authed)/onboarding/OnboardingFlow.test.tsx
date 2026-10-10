import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OnboardingFlow } from './OnboardingFlow';
import { PROGRAMS } from '@/lib/programs';
import { PRESET_BASE_SPECS } from '@lifting-logbook/core';
import { getSeedLifts } from './lib';
import { createFirstMacrocycle } from './actions';

jest.mock('./actions', () => ({
  createFirstMacrocycle: jest.fn(async () => undefined),
}));

const mockCreateFirstMacrocycle = createFirstMacrocycle as jest.MockedFunction<
  typeof createFirstMacrocycle
>;

const CATALOG = ['Bench Press', 'Squat', 'Deadlift', 'Overhead Press'];

// RPT is the available intermediate program used for most flow tests.
const RPT_LIFTS = getSeedLifts(PRESET_BASE_SPECS['rpt']).map((r) => r.lift);
if (!RPT_LIFTS.length) throw new Error("Test setup: rpt spec is empty — check PRESET_BASE_SPECS['rpt']");

/** Navigate to the program step, select RPT in the detail view. */
async function selectRpt(user: ReturnType<typeof userEvent.setup>) {
  const rpt = PROGRAMS.find((p) => p.id === 'rpt');
  if (!rpt) throw new Error('Test setup: rpt missing from PROGRAMS catalog');
  await user.click(screen.getByRole('tab', { name: new RegExp(rpt.experience, 'i') }));
  await user.click(screen.getByText(rpt.name));
  await user.click(screen.getByRole('button', { name: /choose this program/i }));
}

describe('OnboardingFlow — persistence of confirmed maxes', () => {
  beforeEach(() => {
    mockCreateFirstMacrocycle.mockClear();
  });

  it('passes the computed maxes to createFirstMacrocycle on completion (estimate method)', async () => {
    const user = userEvent.setup();
    const rpt = PROGRAMS.find((p) => p.id === 'rpt');
    if (!rpt) throw new Error('Test setup: rpt missing from PROGRAMS catalog');

    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0 (Method) → Step 1 (Program)
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1 (Program): choose RPT → seeds 9 lifts → Step 2 (Enter Lifts)
    await selectRpt(user);

    // Step 2: fill each seeded lift with 200 × 5 → Brzycki 1RM 225 → TM 202.5
    // (floored to the nearest 2.5, not rounded — 225 * 0.9 = 202.5 exactly)
    for (const lift of RPT_LIFTS) {
      await user.type(screen.getByLabelText(`${lift} weight`), '200');
      await user.type(screen.getByLabelText(`${lift} reps`), '5');
    }

    // Step 2 → Step 3 (Confirm)
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 3: submit
    await user.click(screen.getByRole('button', { name: /start my program/i }));

    expect(mockCreateFirstMacrocycle).toHaveBeenCalledTimes(1);
    expect(mockCreateFirstMacrocycle).toHaveBeenCalledWith(
      rpt.id,
      RPT_LIFTS.map((lift) => ({ lift, trainingMax: 202.5 })),
    );
  });

  it('persists entered training maxes as-is when the "tm" method is used (no 90% derivation)', async () => {
    const user = userEvent.setup();
    const rpt = PROGRAMS.find((p) => p.id === 'rpt');
    if (!rpt) throw new Error('Test setup: rpt missing from PROGRAMS catalog');

    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0: pick the "Enter training maxes" method, then advance.
    await user.click(screen.getByRole('button', { name: /enter training maxes/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1 (Program): choose RPT → seeds 9 lifts → Step 2 (Enter Lifts)
    await selectRpt(user);

    // Weight-only rows (no reps input) — enter 315 for each, except the first
    // lift gets a decimal value to prove full precision is preserved (2.5/1.25
    // plate increments), not just whole numbers.
    const [decimalLift, ...wholeLifts] = RPT_LIFTS;
    if (!decimalLift) throw new Error('Test setup: RPT_LIFTS is empty');
    for (const lift of RPT_LIFTS) {
      expect(screen.queryByLabelText(`${lift} reps`)).not.toBeInTheDocument();
      await user.type(screen.getByLabelText(`${lift} weight`), lift === decimalLift ? '316.25' : '315');
    }

    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /start my program/i }));

    // Entered as-is → persisted as-is (not 283 which would be 90% of 315 rounded).
    expect(mockCreateFirstMacrocycle).toHaveBeenCalledTimes(1);
    expect(mockCreateFirstMacrocycle).toHaveBeenCalledWith(rpt.id, [
      { lift: decimalLift, trainingMax: 316.25 },
      ...wholeLifts.map((lift) => ({ lift, trainingMax: 315 })),
    ]);
  });

  it('persists imported training maxes as-is when the "import" method is used (not seeded rows)', async () => {
    const user = userEvent.setup();
    const rpt = PROGRAMS.find((p) => p.id === 'rpt');
    if (!rpt) throw new Error('Test setup: rpt missing from PROGRAMS catalog');

    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0: pick "Import from a file", then advance.
    await user.click(screen.getByRole('button', { name: /import from a file/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1 (Program): choose RPT → seeds RPT lifts into state (not visible on import step)
    // → Step 2 (Import)
    await selectRpt(user);

    // Step 2: Upload a training-maxes CSV — Squat has history, so the latest
    // (316.25, a 2.5/1.25-increment decimal) wins.
    const csv = [
      'Date Updated,Lift,Weight',
      '2026-01-01,Squat,300',
      '2026-02-01,Squat,316.25',
      '2026-01-01,Bench Press,225',
    ].join('\n');
    await user.upload(
      screen.getByLabelText(/training-maxes csv/i),
      new File([csv], 'maxes.csv', { type: 'text/csv' }),
    );
    await waitFor(() =>
      expect(screen.getByText(/loaded 2 training maxes/i)).toBeInTheDocument(),
    );

    // Step 2 → Step 3 (Confirm) → submit
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /start my program/i }));

    // Imported TMs persist verbatim (latest per lift, full precision); the 9
    // seeded RPT rows are overwritten by the import, not passed to createFirstMacrocycle.
    expect(mockCreateFirstMacrocycle).toHaveBeenCalledTimes(1);
    expect(mockCreateFirstMacrocycle).toHaveBeenCalledWith(rpt.id, [
      { lift: 'Squat', trainingMax: 316.25 },
      { lift: 'Bench Press', trainingMax: 225 },
    ]);
  });

  it('floors both the entered 1RM and the 90%-derived training max to the nearest 2.5 when the "manual" method is used', async () => {
    const user = userEvent.setup();
    const rpt = PROGRAMS.find((p) => p.id === 'rpt');
    if (!rpt) throw new Error('Test setup: rpt missing from PROGRAMS catalog');

    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0: pick "Enter manually" (1RM), then advance.
    await user.click(screen.getByRole('button', { name: /enter manually/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1 (Program): choose RPT → seeds 9 lifts → Step 2 (Enter Lifts)
    await selectRpt(user);

    // 203 floors to 202.5 (not rounds to 203); 202.5 * 0.9 = 182.25, which
    // floors to 180.
    for (const lift of RPT_LIFTS) {
      expect(screen.queryByLabelText(`${lift} reps`)).not.toBeInTheDocument();
      await user.type(screen.getByLabelText(`${lift} weight`), '203');
    }

    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /start my program/i }));

    expect(mockCreateFirstMacrocycle).toHaveBeenCalledTimes(1);
    expect(mockCreateFirstMacrocycle).toHaveBeenCalledWith(
      rpt.id,
      RPT_LIFTS.map((lift) => ({ lift, trainingMax: 180 })),
    );
  });
});

describe('OnboardingFlow — lift seeding', () => {
  beforeEach(() => {
    mockCreateFirstMacrocycle.mockClear();
  });

  it('(a) seeds lifts from PRESET_BASE_SPECS when a mapped program is selected', async () => {
    const user = userEvent.setup();
    const leangains = PROGRAMS.find((p) => p.id === 'leangains');
    if (!leangains) throw new Error('Test setup: leangains missing from PROGRAMS catalog');
    const leangainsLifts = getSeedLifts(PRESET_BASE_SPECS['leangains']).map((r) => r.lift);
    if (!leangainsLifts.length) throw new Error("Test setup: leangains spec is empty");

    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0 → Step 1
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1: select Leangains (intermediate) → "Choose This Program"
    await user.click(screen.getByRole('tab', { name: new RegExp(leangains.experience, 'i') }));
    await user.click(screen.getByText(leangains.name));
    await user.click(screen.getByRole('button', { name: /choose this program/i }));

    // Step 2 should show all Leangains lifts pre-seeded
    for (const lift of leangainsLifts) {
      expect(screen.getByLabelText(`${lift} weight`)).toBeInTheDocument();
    }
  });

  it('(b) does not overwrite lifts when lifts are already non-empty (program switch)', async () => {
    const user = userEvent.setup();
    const leangains = PROGRAMS.find((p) => p.id === 'leangains');
    if (!leangains) throw new Error('Test setup: leangains missing from PROGRAMS catalog');
    const rpt = PROGRAMS.find((p) => p.id === 'rpt');
    if (!rpt) throw new Error('Test setup: rpt missing from PROGRAMS catalog');
    const leangainsLifts = getSeedLifts(PRESET_BASE_SPECS['leangains']).map((r) => r.lift);
    if (!leangainsLifts.length) throw new Error("Test setup: leangains spec is empty");

    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0 → Step 1
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1: select Leangains → seeds 12 lifts → Step 2
    await user.click(screen.getByRole('tab', { name: new RegExp(leangains.experience, 'i') }));
    await user.click(screen.getByText(leangains.name));
    await user.click(screen.getByRole('button', { name: /choose this program/i }));

    // Verify seeded: a Leangains-only lift is visible
    expect(screen.getByLabelText('Incline DB Press weight')).toBeInTheDocument();

    // Go back to Step 1
    await user.click(screen.getByRole('button', { name: /back/i }));

    // Re-select: switch to RPT (lifts.length > 0, so no re-seeding should fire)
    await user.click(screen.getByText(rpt.name));
    await user.click(screen.getByRole('button', { name: /choose this program/i }));

    // Step 2: still shows all 12 Leangains lifts — not replaced by RPT's 9
    for (const lift of leangainsLifts) {
      expect(screen.getByLabelText(`${lift} weight`)).toBeInTheDocument();
    }

    // RPT-only lift is absent (Barbell Row is in RPT but not Leangains)
    expect(screen.queryByLabelText('Barbell Row weight')).not.toBeInTheDocument();
  });

  it('(d) import path overwrites seeded rows — imported lifts are used for createFirstMacrocycle', async () => {
    const user = userEvent.setup();
    const rpt = PROGRAMS.find((p) => p.id === 'rpt');
    if (!rpt) throw new Error('Test setup: rpt missing from PROGRAMS catalog');

    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0: import method
    await user.click(screen.getByRole('button', { name: /import from a file/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1: choose RPT (seeds RPT lifts into state, invisible on import step)
    await selectRpt(user);

    // Step 2 (Import): upload CSV with only 2 lifts
    const csv = ['Date Updated,Lift,Weight', '2026-01-01,Squat,315', '2026-01-01,Bench Press,225'].join('\n');
    await user.upload(
      screen.getByLabelText(/training-maxes csv/i),
      new File([csv], 'maxes.csv', { type: 'text/csv' }),
    );
    await waitFor(() =>
      expect(screen.getByText(/loaded 2 training maxes/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /start my program/i }));

    // Only the 2 imported lifts reach createFirstMacrocycle — the 9 seeded RPT rows are gone
    expect(mockCreateFirstMacrocycle).toHaveBeenCalledWith(rpt.id, [
      { lift: 'Squat', trainingMax: 315 },
      { lift: 'Bench Press', trainingMax: 225 },
    ]);
  });
});

describe('OnboardingFlow — navigation', () => {
  beforeEach(() => {
    mockCreateFirstMacrocycle.mockClear();
  });

  it('Back button is present at step 1 (Program) and navigates back to step 0 (Method)', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0 → Step 1
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1 must show a Back button (this was missing before the bug fix)
    const backBtn = screen.getByRole('button', { name: /back/i });
    expect(backBtn).toBeInTheDocument();

    // Press Back → should return to step 0 (Method step shows Next again)
    await user.click(backBtn);
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    // Step 0 has no Back button
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
  });

  it('Back button at step 3 (Confirm) navigates back to step 2 (Enter Lifts)', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow catalog={CATALOG} />);

    // Navigate all the way to step 3
    await user.click(screen.getByRole('button', { name: /next/i }));
    await selectRpt(user);
    for (const lift of RPT_LIFTS) {
      await user.type(screen.getByLabelText(`${lift} weight`), '200');
      await user.type(screen.getByLabelText(`${lift} reps`), '5');
    }
    await user.click(screen.getByRole('button', { name: /next/i }));

    // On step 3 (Confirm) — press Back
    await user.click(screen.getByRole('button', { name: /back/i }));

    // Should be back on step 2: a lift weight input is visible
    const firstLift = RPT_LIFTS[0];
    if (!firstLift) throw new Error('Test setup: RPT_LIFTS is empty');
    expect(screen.getByLabelText(`${firstLift} weight`)).toBeInTheDocument();
  });

  it('Next button is disabled on step 2 (import) before a file is uploaded', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow catalog={CATALOG} />);

    // Step 0: pick import method
    await user.click(screen.getByRole('button', { name: /import from a file/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 1: choose RPT → Step 2 (Import view)
    await selectRpt(user);

    // On step 2 with no file uploaded, Next should be disabled
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });
});
