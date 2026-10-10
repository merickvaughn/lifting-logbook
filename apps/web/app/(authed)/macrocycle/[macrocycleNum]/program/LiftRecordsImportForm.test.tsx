import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportError } from '@lifting-logbook/types';
import LiftRecordsImportForm from './LiftRecordsImportForm';
import { importLiftRecords } from '@/lib/client-api';
import { MAX_RENDERED_IMPORT_ERRORS, MAX_RENDERED_IMPORT_SKIPS } from '@/lib/import-constants';

// #911: this form has no interactive remap step of its own, so an unrecognized
// lift name must never leak the strict validator's internal "slot map" wording,
// and the user needs a concrete way forward (a link to the Smart Import Wizard).
jest.mock('@/lib/client-api', () => ({
  importLiftRecords: jest.fn(),
}));

const mockImport = importLiftRecords as jest.MockedFunction<typeof importLiftRecords>;

async function uploadAndSubmit() {
  const user = userEvent.setup();
  const { container } = render(<LiftRecordsImportForm program="5-3-1" />);
  const file = new File(['Program,Lift\n5-3-1,X'], 'upload.csv', { type: 'text/csv' });
  await user.upload(screen.getByLabelText('CSV file'), file);
  // fireEvent.submit (not a click on the submit button) — jsdom's native HTML5
  // constraint validation for a required <input type="file"> doesn't reliably
  // recognize a user-event-populated FileList as satisfying `required`, which
  // silently blocks the click-driven submit before React's onSubmit ever runs.
  // Dispatching the submit event directly sidesteps that jsdom gap while still
  // exercising the real handleSubmit logic against the file already attached
  // to the input via user.upload above. Wrapped in an async act() so the
  // resulting state updates (handleSubmit is itself async) are flushed before
  // any assertion runs, rather than relying solely on findBy*'s own polling.
  await act(async () => {
    fireEvent.submit(container.querySelector('form')!);
  });
}

describe('LiftRecordsImportForm — error rendering (#911)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('never renders the raw internal "slot map" wording', async () => {
    const errors: ImportError[] = [
      {
        row: 5,
        field: 'lift',
        code: 'UNRECOGNIZED_LIFT',
        message:
          "'Wide-Grip CBL Curls' isn't a recognized exercise. Map it to an existing exercise or create a new one before importing.",
      },
    ];
    mockImport.mockResolvedValue({ ok: false, errors });

    await uploadAndSubmit();

    expect(await screen.findByText(/isn't a recognized exercise/)).toBeInTheDocument();
    expect(screen.queryByText(/slot map/i)).not.toBeInTheDocument();
  });

  it('shows a link to the Smart Import Wizard when a lift-field error is present', async () => {
    const errors: ImportError[] = [
      { row: 5, field: 'lift', code: 'UNRECOGNIZED_LIFT', message: "'X' isn't a recognized exercise." },
    ];
    mockImport.mockResolvedValue({ ok: false, errors });

    await uploadAndSubmit();

    const link = await screen.findByRole('link', { name: /smart import wizard/i });
    expect(link).toHaveAttribute('href', '/import');
  });

  it('does not show the wizard link when every error is a non-lift field', async () => {
    const errors: ImportError[] = [
      { row: 2, field: 'weight', code: 'WEIGHT_INVALID', message: 'weight is not a number' },
      { row: 3, field: 'date', code: 'DATE_INVALID', message: 'date is invalid' },
    ];
    mockImport.mockResolvedValue({ ok: false, errors });

    await uploadAndSubmit();

    await screen.findByText(/weight is not a number/);
    expect(screen.queryByRole('link', { name: /smart import wizard/i })).not.toBeInTheDocument();
  });

  // Regression guard (#911 review, seventh pass): this form is all-or-nothing
  // against up to MAX_IMPORT_ROWS rows, and a CSV whose exercise column isn't
  // named "Lift" produces one error per row — an uncapped list could render
  // thousands of <li>s. Capped like ImportWizard.tsx's own commitErrors list.
  it('caps the rendered error list rather than rendering every row', async () => {
    // Fixture size and the expected overflow count are both derived from the
    // shared constant, not hardcoded — a raw `25`/`toHaveLength(20)` would
    // silently stop testing the real cap the moment MAX_RENDERED_IMPORT_ERRORS
    // changes, recreating the exact drift the constant was extracted to
    // prevent (#911 review, ninth pass).
    const overflowCount = 5;
    const totalErrors = MAX_RENDERED_IMPORT_ERRORS + overflowCount;
    const errors: ImportError[] = Array.from({ length: totalErrors }, (_, i) => ({
      row: i + 1,
      field: 'lift',
      code: 'UNRECOGNIZED_LIFT',
      message: `'Row ${i + 1} Lift' isn't a recognized exercise.`,
    }));
    mockImport.mockResolvedValue({ ok: false, errors });

    await uploadAndSubmit();

    await screen.findByText(/Row 1 Lift/);
    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_RENDERED_IMPORT_ERRORS);
    expect(screen.queryByText(new RegExp(`Row ${totalErrors} Lift`))).not.toBeInTheDocument();
    // #911 review, eighth pass: the cap must be visible, not silent — a user
    // who fixes only the visible rows and re-uploads should not be surprised
    // by a second rejection with no warning more errors existed.
    expect(
      screen.getByText(new RegExp(`…and ${overflowCount} more error\\(s\\) not shown\\.`)),
    ).toBeInTheDocument();
  });

  // #911 review, eighth pass: the "N more" indicator must not render at all
  // when the full list already fits — it would otherwise (falsely) suggest
  // hidden errors exist.
  it('does not show a "more errors" indicator when the error list is not capped', async () => {
    const errors: ImportError[] = Array.from({ length: 3 }, (_, i) => ({
      row: i + 1,
      field: 'lift',
      code: 'UNRECOGNIZED_LIFT',
      message: `'Row ${i + 1} Lift' isn't a recognized exercise.`,
    }));
    mockImport.mockResolvedValue({ ok: false, errors });

    await uploadAndSubmit();

    await screen.findByText(/Row 1 Lift/);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText(/more error\(s\) not shown/)).not.toBeInTheDocument();
  });

  // #911 review, ninth pass: the skipped-rows list (a successful-import side
  // channel, not an error) had the identical unbounded-render risk as the
  // error lists above — up to MAX_IMPORT_ROWS entries, silently uncapped
  // before this fix, and never previously covered by any test in this file.
  it('caps the rendered skipped-rows list and shows a "more" indicator', async () => {
    const overflowCount = 5;
    const totalSkipped = MAX_RENDERED_IMPORT_SKIPS + overflowCount;
    const skipped = Array.from({ length: totalSkipped }, (_, i) => ({
      row: i + 1,
      naturalKey: `5-3-1-4-1-20260420-Bench Press-${i + 1}`,
    }));
    mockImport.mockResolvedValue({ ok: true, data: { written: 1, skipped } });

    const user = userEvent.setup();
    await uploadAndSubmit();

    await screen.findByText(/Skipped rows/);
    await user.click(screen.getByText('Skipped rows'));

    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_RENDERED_IMPORT_SKIPS);
    expect(screen.queryByText(new RegExp(`Row ${totalSkipped}:`))).not.toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`…and ${overflowCount} more skipped row\\(s\\) not shown\\.`)),
    ).toBeInTheDocument();
  });

  // #911 review, tenth pass: mirrors the error list's own "no indicator when
  // not capped" guard above — without this, a `>` accidentally flipped to
  // `>=` would render "…and 0 more skipped row(s) not shown." with the rest
  // of the suite still green.
  it('does not show a "more skipped rows" indicator when the skipped list is not capped', async () => {
    const skipped = Array.from({ length: 3 }, (_, i) => ({
      row: i + 1,
      naturalKey: `5-3-1-4-1-20260420-Bench Press-${i + 1}`,
    }));
    mockImport.mockResolvedValue({ ok: true, data: { written: 1, skipped } });

    const user = userEvent.setup();
    await uploadAndSubmit();

    await screen.findByText(/Skipped rows/);
    await user.click(screen.getByText('Skipped rows'));

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText(/more skipped row\(s\) not shown/)).not.toBeInTheDocument();
  });
});
