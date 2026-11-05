import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GoogleSheetTab, ImportKind, ImportPreviewResponse } from '@lifting-logbook/types';
import { ImportWizard } from './ImportWizard';
import { fetchGoogleSheetWorkbook, previewImport } from '@/lib/client-api';
import type { ImportTarget } from './steps';

jest.mock('@/lib/client-api', () => ({
  previewImport: jest.fn(),
  commitImport: jest.fn(),
  undoImport: jest.fn(),
  fetchGoogleSheetWorkbook: jest.fn(),
  createCustomLift: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));

const mockPreview = previewImport as jest.MockedFunction<typeof previewImport>;
const mockFetchSheet = fetchGoogleSheetWorkbook as jest.MockedFunction<typeof fetchGoogleSheetWorkbook>;

const TEMPLATE: ImportTarget = { id: '5-3-1', name: '5/3/1', isTemplate: true };
const CUSTOM: ImportTarget = { id: 'prog-1', name: 'My Program' };
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/15s6_k614x9FzQtHxQDxh82CjDKYqHaS-VZtmS0he-8Q/edit';
const CSV_FILE = new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' });
const PROGRAM_FILE_NOTE = /can only be imported into a custom program/i;

function previewAs(destination: ImportKind | null): ImportPreviewResponse {
  return {
    classification: {
      type: destination,
      confidence: destination ? 0.95 : 0.2,
      bucket: destination ? 'high' : 'low',
      reasons: [],
      alternatives: [],
    },
    destination,
    columnMappings: [],
    preview: destination ? { creates: 1, updates: 0, skips: 0, unresolved: 0, deltas: [] } : null,
    errors: [],
  };
}

function sheetTab(name: string, kind: ImportKind): GoogleSheetTab {
  return {
    name,
    rowCount: 4,
    classification: { type: kind, confidence: 0.9, bucket: 'high', reasons: [], alternatives: [] },
    suggestedKind: kind,
    csv: 'a,b\n1,2',
    skipReason: null,
  };
}

async function analyzeFile(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('CSV file'), CSV_FILE);
  await user.click(screen.getByRole('button', { name: 'Analyze' }));
  await screen.findByText('What we found');
}

async function fetchWorkbook(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Google Sheets'));
  await user.type(screen.getByLabelText('Google Sheets link'), SHEET_URL);
  await user.click(screen.getByRole('button', { name: 'Fetch workbook' }));
  await screen.findByText('Choose tabs to import');
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('ImportWizard with a template program (#1115)', () => {
  it('lets a user whose only program is a template analyze a lift-history file', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(previewAs('lift-records'));
    render(<ImportWizard programs={[TEMPLATE]} customLifts={[]} />);

    expect(screen.queryByText(/don.t have a program yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '5/3/1 (template)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Program')).toHaveValue('5-3-1');
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled();

    await user.upload(screen.getByLabelText('CSV file'), CSV_FILE);
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Analyze' }));
    await screen.findByText('What we found');

    expect(mockPreview).toHaveBeenCalledWith('5-3-1', CSV_FILE, undefined);
    expect(screen.queryByText(PROGRAM_FILE_NOTE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
  });

  it('lets a user whose only program is a template fetch a Google Sheet', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: [sheetTab('LIFT_RECORDS', 'lift-records')] });
    mockPreview.mockResolvedValue(previewAs('lift-records'));
    render(<ImportWizard programs={[TEMPLATE]} customLifts={[]} />);

    await fetchWorkbook(user);

    expect(mockFetchSheet).toHaveBeenCalledWith('5-3-1', SHEET_URL);
    expect(within(rowFor('LIFT_RECORDS')).getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Import 1 tab' })).toBeEnabled();
  });

  it('asks an account with no program at all to choose one', () => {
    render(<ImportWizard programs={[]} customLifts={[]} />);

    expect(screen.getByRole('link', { name: 'Choose one' })).toHaveAttribute('href', '/programs');
    expect(screen.queryByLabelText('Program')).not.toBeInTheDocument();
  });

  describe('program files still need a custom program', () => {
    it('stops a file detected as a program at Classify on a template', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(previewAs('program-spec'));
      render(<ImportWizard programs={[TEMPLATE]} customLifts={[]} />);

      await analyzeFile(user);

      expect(screen.getByText(PROGRAM_FILE_NOTE)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    });

    it('continues past Classify for the same file on a custom program', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(previewAs('program-spec'));
      render(<ImportWizard programs={[CUSTOM, TEMPLATE]} customLifts={[]} />);

      await analyzeFile(user);

      expect(screen.queryByText(PROGRAM_FILE_NOTE)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    });

    it('does not offer Program as a destination for an unclassified file on a template', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(previewAs(null));
      render(<ImportWizard programs={[TEMPLATE]} customLifts={[]} />);

      await analyzeFile(user);

      expect(screen.getByRole('button', { name: /Lift History/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Program/ })).not.toBeInTheDocument();
    });

    it('offers Program as a destination for an unclassified file on a custom program', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(previewAs(null));
      render(<ImportWizard programs={[CUSTOM]} customLifts={[]} />);

      await analyzeFile(user);

      expect(screen.getByRole('button', { name: /^Program/ })).toBeInTheDocument();
    });

    it('will not let a Google Sheets tab detected as a program be checked on a template', async () => {
      const user = userEvent.setup();
      mockFetchSheet.mockResolvedValue({
        tabs: [sheetTab('LIFT_RECORDS', 'lift-records'), sheetTab('PROGRAM', 'program-spec')],
      });
      mockPreview.mockResolvedValue(previewAs('lift-records'));
      render(<ImportWizard programs={[TEMPLATE]} customLifts={[]} />);

      await fetchWorkbook(user);

      expect(within(rowFor('PROGRAM')).getByRole('checkbox')).toBeDisabled();
      expect(within(rowFor('PROGRAM')).getByText('Program: needs a custom program')).toBeInTheDocument();
      expect(within(screen.getByLabelText('Import LIFT_RECORDS as')).queryByRole('option', { name: /^Program/ })).toBeNull();
    });

    it('lets a tab that is only a best guess at a program be imported as something else on a template', async () => {
      const user = userEvent.setup();
      const bestGuess: GoogleSheetTab = {
        ...sheetTab('MYSTERY', 'program-spec'),
        classification: { type: null, confidence: 0.5, bucket: 'medium', reasons: [], alternatives: [] },
      };
      mockFetchSheet.mockResolvedValue({ tabs: [bestGuess] });
      mockPreview.mockResolvedValue(previewAs('lift-records'));
      render(<ImportWizard programs={[TEMPLATE]} customLifts={[]} />);

      await fetchWorkbook(user);
      await user.click(within(rowFor('MYSTERY')).getByRole('checkbox'));

      expect(screen.getByLabelText('Import MYSTERY as')).toHaveValue('lift-records');
      await waitFor(() =>
        expect(mockPreview).toHaveBeenCalledWith('5-3-1', expect.any(File), 'lift-records'),
      );
      expect(screen.getByRole('button', { name: 'Import 1 tab' })).toBeEnabled();
    });

    it('unchecks a tab chosen as a program when the picker moves to a template', async () => {
      const user = userEvent.setup();
      mockFetchSheet.mockResolvedValue({
        tabs: [sheetTab('LIFT_RECORDS', 'lift-records'), sheetTab('PROGRAM', 'program-spec')],
      });
      mockPreview.mockImplementation(async (_program, _file, destination) => previewAs(destination ?? 'lift-records'));
      render(<ImportWizard programs={[CUSTOM, TEMPLATE]} customLifts={[]} />);

      await fetchWorkbook(user);
      await user.click(within(rowFor('PROGRAM')).getByRole('checkbox'));
      expect(screen.getByRole('button', { name: 'Import 2 tabs' })).toBeEnabled();

      await user.selectOptions(screen.getByLabelText('Program'), '5-3-1');
      expect(within(rowFor('PROGRAM')).getByRole('checkbox')).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Import 1 tab' })).toBeEnabled();
      await waitFor(() =>
        expect(mockPreview.mock.calls.some(([program]) => program === '5-3-1')).toBe(true),
      );
      expect(
        mockPreview.mock.calls.some(([program, , kind]) => program === '5-3-1' && kind === 'program-spec'),
      ).toBe(false);

      await user.selectOptions(screen.getByLabelText('Program'), 'prog-1');
      expect(within(rowFor('PROGRAM')).getByRole('checkbox')).not.toBeChecked();
      expect(within(rowFor('PROGRAM')).getByRole('checkbox')).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Import 1 tab' })).toBeEnabled();
    });
  });

  describe('when a program fetch failed', () => {
    const LOAD_FAILED = /couldn.t load all of your programs/i;

    it('says the list may be incomplete instead of saying the user has no program', () => {
      render(<ImportWizard programs={[]} programsLoadFailed customLifts={[]} />);

      expect(screen.getByText(LOAD_FAILED)).toBeInTheDocument();
      expect(screen.queryByText(/don.t have a program yet/i)).not.toBeInTheDocument();
    });

    it('still offers the programs that did load', () => {
      render(<ImportWizard programs={[CUSTOM]} programsLoadFailed customLifts={[]} />);

      expect(screen.getByText(LOAD_FAILED)).toBeInTheDocument();
      expect(screen.getByLabelText('Program')).toHaveValue('prog-1');
    });

    it('shows no warning when nothing failed', () => {
      render(<ImportWizard programs={[CUSTOM]} customLifts={[]} />);

      expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
    });
  });
});
