import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CustomProgramSummaryResponse,
  GoogleSheetTab,
  ImportClassification,
  ImportKind,
  ImportPreviewResponse,
} from '@lifting-logbook/types';
import { ImportWizard } from './ImportWizard';
import { defaultTabChoices } from './SheetTabsStep';
import { commitImport, fetchGoogleSheetWorkbook, previewImport, undoImport } from '@/lib/client-api';

jest.mock('@/lib/client-api', () => ({
  previewImport: jest.fn(),
  commitImport: jest.fn(),
  undoImport: jest.fn(),
  fetchGoogleSheetWorkbook: jest.fn(),
  createCustomLift: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));

const mockPreview = previewImport as jest.MockedFunction<typeof previewImport>;
const mockCommit = commitImport as jest.MockedFunction<typeof commitImport>;
const mockUndo = undoImport as jest.MockedFunction<typeof undoImport>;
const mockFetchSheet = fetchGoogleSheetWorkbook as jest.MockedFunction<typeof fetchGoogleSheetWorkbook>;

const PROGRAMS: CustomProgramSummaryResponse[] = [
  { id: 'prog-1', name: 'My Program', description: null, baseTemplate: null, createdAt: '2026-01-01' },
];

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/15s6_k614x9FzQtHxQDxh82CjDKYqHaS-VZtmS0he-8Q/edit';

function classified(type: ImportKind | null, confidence: number): ImportClassification {
  return { type, confidence, bucket: type ? 'high' : 'low', reasons: [], alternatives: [] };
}

function tab(name: string, type: ImportKind | null, confidence: number, csv: string | null): GoogleSheetTab {
  return { name, rowCount: 4, classification: classified(type, confidence), csv };
}

const TABS: GoogleSheetTab[] = [
  tab('TOC', null, 0.1, null),
  tab('LIFT_RECORDS', 'lift-records', 0.95, 'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes\nRPT,38,1,12/29/2025,Bench P.,1,180,8,'),
  tab('TRAINING_MAXES', 'training-maxes', 0.93, 'Date Updated,Lift,Weight\n9/25/2026,Bench P.,172.5'),
  tab('Strength_Goals', 'strength-goals', 0.8, 'Lift,Current TM,Intermediate,Advanced,Elite\nSquat,250,280,350,420'),
];

const PREVIEWS: Record<ImportKind, ImportPreviewResponse> = {
  'lift-records': {
    classification: classified('lift-records', 0.95),
    destination: 'lift-records',
    columnMappings: [
      { sourceHeader: 'Cycle #', destinationField: 'macrocycleNum', confidence: 0.9, required: true },
      { sourceHeader: 'Lift', destinationField: 'lift', confidence: 1, required: true },
    ],
    preview: {
      creates: 3,
      updates: 0,
      skips: 1,
      deltas: [{ key: '38:1:20251229:bench-press:1', label: 'bench-press', kind: 'create', after: '180 × 8' }],
    },
    errors: [],
  },
  'training-maxes': {
    classification: classified('training-maxes', 0.93),
    destination: 'training-maxes',
    columnMappings: [{ sourceHeader: 'Lift', destinationField: 'lift', confidence: 1, required: true }],
    preview: {
      creates: 1,
      updates: 0,
      skips: 0,
      deltas: [{ key: 'bench-press', label: 'bench-press', kind: 'create', after: '172.5' }],
    },
    errors: [],
  },
  'strength-goals': {
    classification: classified('strength-goals', 0.8),
    destination: 'strength-goals',
    columnMappings: [],
    preview: { creates: 2, updates: 0, skips: 0, deltas: [] },
    errors: [],
  },
  'program-spec': {
    classification: classified('program-spec', 0.8),
    destination: 'program-spec',
    columnMappings: [],
    preview: { creates: 0, updates: 0, skips: 0, deltas: [] },
    errors: [],
  },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockPreview.mockImplementation(async (_program, _file, destination) => PREVIEWS[destination ?? 'lift-records']);
});

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

describe('defaultTabChoices', () => {
  it('pre-selects the most confident lift-history and training-max tabs only', () => {
    const choices = defaultTabChoices([...TABS, tab('OLD_LIFT_RECORDS', 'lift-records', 0.85, 'x')]);
    expect(choices).toEqual({ LIFT_RECORDS: 'lift-records', TRAINING_MAXES: 'training-maxes' });
  });
});

describe('Google Sheets import (#1111)', () => {
  it('lists importable tabs with lift history and training maxes pre-selected, and previews them', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    await fetchWorkbook(user);

    expect(mockFetchSheet).toHaveBeenCalledWith('prog-1', SHEET_URL);
    expect(within(rowFor('LIFT_RECORDS')).getByRole('checkbox')).toBeChecked();
    expect(within(rowFor('TRAINING_MAXES')).getByRole('checkbox')).toBeChecked();
    expect(within(rowFor('Strength_Goals')).getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText('1 tab not importable')).toBeInTheDocument();

    // Each checked tab is previewed through the regular import endpoint as a CSV file.
    await waitFor(() => expect(within(rowFor('LIFT_RECORDS')).getByText('3 new · 0 updated · 1 skipped')).toBeInTheDocument());
    expect(within(rowFor('LIFT_RECORDS')).getByText('Cycle # → macrocycleNum (90%)')).toBeInTheDocument();
    const liftFile = mockPreview.mock.calls.find(([, , kind]) => kind === 'lift-records')?.[1];
    expect(liftFile?.name).toBe('LIFT_RECORDS.csv');

    expect(screen.getByRole('button', { name: 'Import 2 tabs' })).toBeEnabled();
  });

  it('previews a tab under the kind the user picks', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await fetchWorkbook(user);

    await user.click(within(rowFor('Strength_Goals')).getByRole('checkbox'));
    await user.selectOptions(screen.getByLabelText('Import Strength_Goals as'), 'program-spec');

    await waitFor(() =>
      expect(mockPreview.mock.calls.some(([, file, kind]) => file.name === 'Strength_Goals.csv' && kind === 'program-spec')).toBe(true),
    );
    expect(screen.getByRole('button', { name: 'Import 3 tabs' })).toBeEnabled();
  });

  it('shows the sharing instructions when the sheet is private', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockRejectedValue(new Error('This sheet is not shared.'));
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    await user.click(screen.getByLabelText('Google Sheets'));
    await user.type(screen.getByLabelText('Google Sheets link'), SHEET_URL);
    await user.click(screen.getByRole('button', { name: 'Fetch workbook' }));

    expect(await screen.findByText('This sheet is not shared.')).toBeInTheDocument();
  });

  it('steps through each selected tab, committing each and offering undo for earlier ones', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    mockCommit
      .mockResolvedValueOnce({
        ok: true,
        data: { destination: 'lift-records', created: 3, updated: 0, skipped: 1, batchId: 'batch-lifts', skippedDetail: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { destination: 'training-maxes', created: 1, updated: 0, skipped: 0, batchId: 'batch-tms' },
      });
    mockUndo.mockResolvedValue({ batchId: 'batch-lifts', restored: 3, skipped: 0, flagged: [] });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await fetchWorkbook(user);

    // Tab 1: LIFT_RECORDS — lands on MAP_COLUMNS with its destination already chosen.
    await user.click(screen.getByRole('button', { name: 'Import 2 tabs' }));
    expect(await screen.findByText('Tab 1 of 2: LIFT_RECORDS')).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Map columns' });
    await user.click(screen.getByRole('button', { name: 'Next' })); // Map → Review
    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await screen.findByText('Import complete');
    expect(mockCommit.mock.calls[0]?.[1].name).toBe('LIFT_RECORDS.csv');
    expect(mockCommit.mock.calls[0]?.[2]).toBe('lift-records');

    // Tab 2: TRAINING_MAXES.
    await user.click(screen.getByRole('button', { name: 'Next tab: TRAINING_MAXES' }));
    expect(await screen.findByText('Tab 2 of 2: TRAINING_MAXES')).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Map columns' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await screen.findByText('Import complete');
    expect(mockCommit.mock.calls[1]?.[2]).toBe('training-maxes');

    // The earlier tab's result stays visible with its own undo.
    expect(screen.getByText(/LIFT_RECORDS — Lift History: 3 created/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo LIFT_RECORDS' }));
    expect(mockUndo).toHaveBeenCalledWith('prog-1', 'batch-lifts');
    expect(await screen.findByText('Undone (3 restored).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import another file' })).toBeInTheDocument();
  });
});
