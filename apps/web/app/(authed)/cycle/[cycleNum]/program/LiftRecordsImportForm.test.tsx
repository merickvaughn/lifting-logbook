import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportError } from '@lifting-logbook/types';
import LiftRecordsImportForm from './LiftRecordsImportForm';
import { importLiftRecords } from '@/lib/client-api';

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
      { row: 5, field: 'lift', message: "'X' isn't a recognized exercise." },
    ];
    mockImport.mockResolvedValue({ ok: false, errors });

    await uploadAndSubmit();

    const link = await screen.findByRole('link', { name: /smart import wizard/i });
    expect(link).toHaveAttribute('href', '/import');
  });

  it('does not show the wizard link when every error is a non-lift field', async () => {
    const errors: ImportError[] = [
      { row: 2, field: 'weight', message: 'weight is not a number' },
      { row: 3, field: 'date', message: 'date is invalid' },
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
    const errors: ImportError[] = Array.from({ length: 25 }, (_, i) => ({
      row: i + 1,
      field: 'lift',
      message: `'Row ${i + 1} Lift' isn't a recognized exercise.`,
    }));
    mockImport.mockResolvedValue({ ok: false, errors });

    await uploadAndSubmit();

    await screen.findByText(/Row 1 Lift/);
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    expect(screen.queryByText(/Row 25 Lift/)).not.toBeInTheDocument();
    // #911 review, eighth pass: the cap must be visible, not silent — a user
    // who fixes only the 20 shown and re-uploads should not be surprised by
    // a second rejection with no warning more errors existed.
    expect(screen.getByText(/…and 5 more error\(s\) not shown\./)).toBeInTheDocument();
  });

  // #911 review, eighth pass: the "N more" indicator must not render at all
  // when the full list already fits — it would otherwise (falsely) suggest
  // hidden errors exist.
  it('does not show a "more errors" indicator when the error list is not capped', async () => {
    const errors: ImportError[] = Array.from({ length: 3 }, (_, i) => ({
      row: i + 1,
      field: 'lift',
      message: `'Row ${i + 1} Lift' isn't a recognized exercise.`,
    }));
    mockImport.mockResolvedValue({ ok: false, errors });

    await uploadAndSubmit();

    await screen.findByText(/Row 1 Lift/);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText(/more error\(s\) not shown/)).not.toBeInTheDocument();
  });
});
