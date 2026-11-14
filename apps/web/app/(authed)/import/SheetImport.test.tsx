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
import { commitImport, dryRunImport, fetchGoogleSheetWorkbook, previewImport, undoImport } from '@/lib/client-api';

jest.mock('@/lib/client-api', () => ({
  previewImport: jest.fn(),
  commitImport: jest.fn(),
  dryRunImport: jest.fn(),
  undoImport: jest.fn(),
  fetchGoogleSheetWorkbook: jest.fn(),
  createCustomLift: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));

const mockPreview = previewImport as jest.MockedFunction<typeof previewImport>;
const mockCommit = commitImport as jest.MockedFunction<typeof commitImport>;
const mockDryRun = dryRunImport as jest.MockedFunction<typeof dryRunImport>;
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
  return {
    name,
    rowCount: 4,
    classification: classified(type, confidence),
    suggestedKind: csv === null ? null : type,
    csv,
    skipReason: csv === null ? 'Not recognized as lift history, training maxes, strength goals or a program.' : null,
  };
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
      unresolved: 0,
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
      unresolved: 0,
      deltas: [{ key: 'bench-press', label: 'bench-press', kind: 'create', after: '172.5' }],
    },
    errors: [],
  },
  'strength-goals': {
    classification: classified('strength-goals', 0.8),
    destination: 'strength-goals',
    columnMappings: [],
    preview: { creates: 2, updates: 0, skips: 0, unresolved: 0, deltas: [] },
    errors: [],
  },
  'program-spec': {
    classification: classified('program-spec', 0.8),
    destination: 'program-spec',
    columnMappings: [],
    preview: { creates: 0, updates: 0, skips: 0, unresolved: 0, deltas: [] },
    errors: [],
  },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockDryRun.mockImplementation(async (_program, _file, destination) => ({
    ok: true,
    data: { destination, created: 1, updated: 0, skipped: 0 },
  }));
  mockPreview.mockImplementation(async (_program, _file, destination) => PREVIEWS[destination ?? 'lift-records']);
});

// Paste the link rather than `user.type` it. Typing sends a burst of key events and a
// timer yield per character, and each character's `input` re-renders the whole wizard:
// the 84-character link took 3.6 s of a 9 s test run alone, and under a parallel Windows
// run that pushed a test past its 15 s timeout (#1232). Pasting is one `input` event.
async function enterSheetLink(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Google Sheets link'));
  await user.paste(SHEET_URL);
}

async function fetchWorkbook(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Google Sheets'));
  await enterSheetLink(user);
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

  it('shows rows that still need a lift apart from new rows in the tab preview (#1114)', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    mockPreview.mockImplementation(async (_program, _file, destination) => {
      const res = PREVIEWS[destination ?? 'lift-records'];
      return destination === 'lift-records'
        ? { ...res, preview: { creates: 3, updates: 0, skips: 1, unresolved: 22, deltas: [] } }
        : res;
    });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    await fetchWorkbook(user);

    await waitFor(() =>
      expect(
        within(rowFor('LIFT_RECORDS')).getByText('3 new · 0 updated · 1 skipped · 22 to review'),
      ).toBeInTheDocument(),
    );
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
    await enterSheetLink(user);
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
    expect(mockUndo).toHaveBeenCalledWith('prog-1', 'batch-lifts', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(await screen.findByText('Undone (3 restored).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import another file' })).toBeInTheDocument();
  });

  it('reuses the overview preview when a tab starts instead of uploading it again', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await fetchWorkbook(user);
    await waitFor(() => expect(within(rowFor('TRAINING_MAXES')).getByText('1 new · 0 updated · 0 skipped')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Import 2 tabs' }));
    await screen.findByRole('heading', { name: 'Map columns' });

    expect(mockPreview.mock.calls.filter(([, file]) => file.name === 'LIFT_RECORDS.csv')).toHaveLength(1);
  });

  it('resumes after a failed tab without re-importing the committed one or losing its undo', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    mockCommit.mockResolvedValueOnce({
      ok: true,
      data: { destination: 'lift-records', created: 3, updated: 0, skipped: 1, batchId: 'batch-lifts', skippedDetail: [] },
    });
    // TRAINING_MAXES fails twice: its overview preview, then again when its tab starts.
    let tmFailures = 2;
    mockPreview.mockImplementation(async (_program, file, destination) => {
      if (file.name === 'TRAINING_MAXES.csv' && tmFailures-- > 0) throw new Error('Import preview failed (HTTP 500)');
      return PREVIEWS[destination ?? 'lift-records'];
    });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await fetchWorkbook(user);
    await within(rowFor('TRAINING_MAXES')).findByText('Import preview failed (HTTP 500)');

    await user.click(screen.getByRole('button', { name: 'Import 2 tabs' }));
    await screen.findByRole('heading', { name: 'Map columns' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await screen.findByText('Import complete');

    // The second tab's start fails, which returns to the overview with the run kept.
    await user.click(screen.getByRole('button', { name: 'Next tab: TRAINING_MAXES' }));
    await screen.findByText('Choose tabs to import');
    expect(screen.getAllByText('Import preview failed (HTTP 500)').length).toBeGreaterThan(0);

    // Only the uncommitted tab is offered again.
    expect(screen.getByRole('button', { name: 'Import 1 tab' })).toBeEnabled();
    mockCommit.mockResolvedValueOnce({
      ok: true,
      data: { destination: 'training-maxes', created: 1, updated: 0, skipped: 0, batchId: 'batch-tms' },
    });
    await user.click(screen.getByRole('button', { name: 'Import 1 tab' }));
    expect(await screen.findByText('Tab 1 of 1: TRAINING_MAXES')).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Map columns' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await screen.findByText('Import complete');

    expect(mockCommit.mock.calls.map(([, file]) => file.name)).toEqual(['LIFT_RECORDS.csv', 'TRAINING_MAXES.csv']);
    expect(screen.getByRole('button', { name: 'Undo LIFT_RECORDS' })).toBeInTheDocument();
  });

  it('retries a failed tab preview when the tab is unchecked and checked again', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    mockPreview.mockRejectedValueOnce(new Error('Import preview failed (HTTP 503)'));
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await fetchWorkbook(user);

    expect(await within(rowFor('LIFT_RECORDS')).findByText('Import preview failed (HTTP 503)')).toBeInTheDocument();
    const checkbox = within(rowFor('LIFT_RECORDS')).getByRole('checkbox');
    await user.click(checkbox);
    await user.click(checkbox);

    expect(await within(rowFor('LIFT_RECORDS')).findByText('3 new · 0 updated · 1 skipped')).toBeInTheDocument();
  });

  it('offers a medium-confidence tab unchecked, as its best-guess kind, and says why a tab is skipped', async () => {
    const user = userEvent.setup();
    const medium: GoogleSheetTab = {
      ...tab('OLD_LOG', null, 0.75, 'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps\nRPT,1,1,1/1/2024,Squat,1,200,5'),
      classification: { type: null, confidence: 0.75, bucket: 'medium', reasons: [], alternatives: [] },
      suggestedKind: 'lift-records',
    };
    const tooBig: GoogleSheetTab = { ...tab('ARCHIVE', 'lift-records', 0.95, null), skipReason: 'More than 5000 rows, the per-import limit.' };
    mockFetchSheet.mockResolvedValue({ tabs: [...TABS, medium, tooBig] });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await fetchWorkbook(user);

    expect(within(rowFor('OLD_LOG')).getByRole('checkbox')).not.toBeChecked();
    await user.click(within(rowFor('OLD_LOG')).getByRole('checkbox'));
    expect(screen.getByLabelText('Import OLD_LOG as')).toHaveDisplayValue('Lift History (best guess, 75%)');
    await waitFor(() =>
      expect(mockPreview.mock.calls.some(([, file, kind]) => file.name === 'OLD_LOG.csv' && kind === 'lift-records')).toBe(true),
    );

    await user.click(screen.getByText('2 tabs not importable'));
    expect(screen.getByText('ARCHIVE — More than 5000 rows, the per-import limit.')).toBeInTheDocument();
  });

  it('previews a later tab again after an earlier tab commits, instead of reusing the stale overview', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'lift-records', created: 3, updated: 0, skipped: 1, batchId: 'batch-1', skippedDetail: [] },
    });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await fetchWorkbook(user);
    await waitFor(() => expect(within(rowFor('TRAINING_MAXES')).getByText('1 new · 0 updated · 0 skipped')).toBeInTheDocument());
    const tmPreviews = () => mockPreview.mock.calls.filter(([, file]) => file.name === 'TRAINING_MAXES.csv').length;
    expect(tmPreviews()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Import 2 tabs' }));
    await screen.findByRole('heading', { name: 'Map columns' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await screen.findByText('Import complete');
    await user.click(screen.getByRole('button', { name: 'Next tab: TRAINING_MAXES' }));
    await screen.findByText('Tab 2 of 2: TRAINING_MAXES');

    await waitFor(() => expect(tmPreviews()).toBe(2));
  });

  it('treats a refetched workbook as new, so a same-named tab can be imported again', async () => {
    const user = userEvent.setup();
    mockFetchSheet.mockResolvedValue({ tabs: TABS });
    // The second tab's start fails, leaving LIFT_RECORDS committed in this run.
    let tmStarts = 0;
    mockPreview.mockImplementation(async (_program, file, destination) => {
      if (file.name === 'TRAINING_MAXES.csv' && ++tmStarts === 2) throw new Error('Import preview failed (HTTP 500)');
      return PREVIEWS[destination ?? 'lift-records'];
    });
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'lift-records', created: 3, updated: 0, skipped: 1, batchId: 'batch-1', skippedDetail: [] },
    });
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await fetchWorkbook(user);
    await waitFor(() => expect(within(rowFor('TRAINING_MAXES')).getByText('1 new · 0 updated · 0 skipped')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Import 2 tabs' }));
    await screen.findByRole('heading', { name: 'Map columns' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await screen.findByText('Import complete');
    await user.click(screen.getByRole('button', { name: 'Next tab: TRAINING_MAXES' }));
    await screen.findByText('Choose tabs to import');
    expect(screen.getByRole('button', { name: 'Import 1 tab' })).toBeInTheDocument();

    // Fetching the link again starts over: both tabs are offered.
    await user.clear(screen.getByLabelText('Google Sheets link'));
    await enterSheetLink(user);
    await user.click(screen.getByRole('button', { name: 'Fetch workbook' }));
    expect(await screen.findByRole('button', { name: 'Import 2 tabs' })).toBeInTheDocument();

    // The tab committed from the first fetch keeps its Undo after the next commit.
    await user.click(screen.getByRole('button', { name: 'Import 2 tabs' }));
    await screen.findByRole('heading', { name: 'Map columns' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await screen.findByText('Import complete');
    expect(screen.getByText('Tabs imported earlier')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo LIFT_RECORDS' })).toBeInTheDocument();
  });

  it('keeps the link field disabled while the workbook is being fetched', async () => {
    const user = userEvent.setup();
    let resolve: (value: { tabs: GoogleSheetTab[] }) => void = () => undefined;
    mockFetchSheet.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    await user.click(screen.getByLabelText('Google Sheets'));
    await enterSheetLink(user);
    await user.click(screen.getByRole('button', { name: 'Fetch workbook' }));

    expect(screen.getByLabelText('Google Sheets link')).toBeDisabled();
    resolve({ tabs: TABS });
    await screen.findByText('Choose tabs to import');
    expect(screen.getByLabelText('Google Sheets link')).toBeEnabled();
  });
});
