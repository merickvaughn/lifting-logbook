import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CustomLiftResponse,
  CustomProgramSummaryResponse,
  ImportPreviewResponse,
} from '@lifting-logbook/types';
import { ImportWizard } from './ImportWizard';
import { commitImport, createCustomLift, fetchCustomLifts, previewImport } from '@/lib/client-api';
import { MAX_RENDERED_IMPORT_ERRORS, MAX_RENDERED_IMPORT_SKIPS } from '@/lib/import-constants';

// File.text() is not implemented in jsdom; use FileReader instead.
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

jest.mock('@/lib/client-api', () => ({
  previewImport: jest.fn(),
  commitImport: jest.fn(),
  createCustomLift: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));

const mockPreview = previewImport as jest.MockedFunction<typeof previewImport>;
const mockCommit = commitImport as jest.MockedFunction<typeof commitImport>;
const mockCreateCustomLift = createCustomLift as jest.MockedFunction<typeof createCustomLift>;
const mockFetchCustomLifts = fetchCustomLifts as jest.MockedFunction<typeof fetchCustomLifts>;

const PROGRAMS: CustomProgramSummaryResponse[] = [
  { id: 'prog-1', name: 'My Program', description: null, baseTemplate: null, createdAt: '2026-01-01' },
];

const LIFT_RECORDS_PREVIEW: ImportPreviewResponse = {
  classification: {
    type: 'lift-records',
    confidence: 0.92,
    bucket: 'high',
    reasons: ['Matched required lift-record columns'],
    alternatives: [],
  },
  destination: 'lift-records',
  columnMappings: [
    { sourceHeader: 'Program', destinationField: 'program', confidence: 1, required: true },
    { sourceHeader: 'Cycle #', destinationField: 'cycleNum', confidence: 1, required: true },
    { sourceHeader: 'Workout #', destinationField: 'workoutNum', confidence: 1, required: true },
    { sourceHeader: 'Date', destinationField: 'date', confidence: 1, required: true },
    { sourceHeader: 'Lift', destinationField: 'lift', confidence: 1, required: true },
    { sourceHeader: 'Set #', destinationField: 'setNum', confidence: 1, required: true },
    { sourceHeader: 'Weight', destinationField: 'weight', confidence: 1, required: true },
    { sourceHeader: 'Reps', destinationField: 'reps', confidence: 1, required: true },
  ],
  preview: {
    creates: 0,
    updates: 0,
    skips: 1,
    deltas: [{ key: '1:1:20260101:bench-press:1', label: 'bench-press', kind: 'skip' }],
  },
  errors: [],
};

const TM_PREVIEW: ImportPreviewResponse = {
  classification: {
    type: 'training-maxes',
    confidence: 0.95,
    bucket: 'high',
    reasons: ['Matched 4/4 expected columns'],
    alternatives: [{ type: 'lift-records', confidence: 0.4, closeCall: false }],
  },
  destination: 'training-maxes',
  columnMappings: [
    { sourceHeader: 'Date Updated', destinationField: 'dateUpdated', confidence: 1.0, required: true },
    { sourceHeader: 'Lift', destinationField: 'lift', confidence: 1.0, required: true },
    { sourceHeader: 'Weight', destinationField: 'weight', confidence: 1.0, required: true },
  ],
  preview: {
    creates: 2,
    updates: 1,
    skips: 0,
    deltas: [
      { key: 'squat', label: 'squat', kind: 'create', after: '300' },
      { key: 'bench', label: 'bench', kind: 'update', before: '200', after: '210' },
    ],
  },
  errors: [],
};

// Navigate from SOURCE to REVIEW: upload file → analyze → Classify Next → Map Next.
async function navigateToReview(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(screen.getByLabelText('CSV file'), file);
  await user.click(screen.getByRole('button', { name: 'Analyze' }));
  await waitFor(() => expect(screen.getByText('Training Maxes')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Next' })); // Classify → Map
  await user.click(screen.getByRole('button', { name: 'Next' })); // Map → Review
}

// Same walkthrough for a lift-records preview, whose CLASSIFY step shows
// "Lift History" rather than "Training Maxes".
async function navigateToLiftRecordsReview(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(screen.getByLabelText('CSV file'), file);
  await user.click(screen.getByRole('button', { name: 'Analyze' }));
  await waitFor(() => expect(screen.getByText('Lift History')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Next' })); // Classify → Map
  await user.click(screen.getByRole('button', { name: 'Next' })); // Map → Review
}

// Full lift-records walkthrough through a successful commit (Review → Preview
// → Commit import → "Import complete"). Extracted so this exact sequence
// isn't hand-copied into every DONE-step test — it already had before this
// (#911 review, tenth pass).
async function commitLiftRecordsImport(user: ReturnType<typeof userEvent.setup>, file: File) {
  await navigateToLiftRecordsReview(user, file);
  await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
  await user.click(screen.getByRole('button', { name: 'Commit import' }));
  await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
}

const CUSTOM_LIFT: CustomLiftResponse = {
  id: 'custom-cbl-curls',
  name: 'Wide-Grip CBL Curls',
  classification: 'accessory',
  movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
  isBodyweightComponent: false,
  isCustom: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const AMBIGUOUS_LIFT_COLUMN_MAPPINGS = [
  { sourceHeader: 'Program', destinationField: 'program', confidence: 1, required: true },
  { sourceHeader: 'Cycle #', destinationField: 'cycleNum', confidence: 1, required: true },
  { sourceHeader: 'Workout #', destinationField: 'workoutNum', confidence: 1, required: true },
  { sourceHeader: 'Date', destinationField: 'date', confidence: 1, required: true },
  { sourceHeader: 'Lift', destinationField: 'lift', confidence: 1, required: true },
  { sourceHeader: 'Set #', destinationField: 'setNum', confidence: 1, required: true },
  { sourceHeader: 'Weight', destinationField: 'weight', confidence: 1, required: true },
  { sourceHeader: 'Reps', destinationField: 'reps', confidence: 1, required: true },
];

// Two ambiguous rows sharing the same unrecognized raw text — the exact shape
// of issue #911's motivating scenario (one CSV export, one recurring
// unrecognized name, many set rows).
const AMBIGUOUS_LIFT_PREVIEW: ImportPreviewResponse = {
  classification: {
    type: 'lift-records',
    confidence: 0.92,
    bucket: 'high',
    reasons: ['Matched required lift-record columns'],
    alternatives: [],
  },
  destination: 'lift-records',
  columnMappings: AMBIGUOUS_LIFT_COLUMN_MAPPINGS,
  preview: {
    creates: 0,
    updates: 0,
    skips: 0,
    deltas: [
      {
        key: '__ambiguous_1',
        label: 'Row 1: Wide-Grip CBL Curls',
        kind: 'create',
        status: 'ambiguous',
        rowIndex: 1,
        originalLift: 'Wide-Grip CBL Curls',
      },
      {
        key: '__ambiguous_2',
        label: 'Row 2: Wide-Grip CBL Curls',
        kind: 'create',
        status: 'ambiguous',
        rowIndex: 2,
        originalLift: 'Wide-Grip CBL Curls',
      },
    ],
  },
  errors: [],
};

const AMBIGUOUS_LIFT_CSV = new File(
  [
    'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps\n' +
      '5-3-1,1,1,2026-01-01,Wide-Grip CBL Curls,1,90,10\n' +
      '5-3-1,1,1,2026-01-01,Wide-Grip CBL Curls,2,90,8',
  ],
  'lifts.csv',
  { type: 'text/csv' },
);

// Two blank Lift CELLS (not a missing Lift column, which would leave every
// row's originalLift undefined) — both parse to originalLift: '' (#911
// review, third pass regression fixture). Row 3 has real text so at least one
// row can exercise the batch-resolve path for comparison.
const BLANK_LIFT_CELL_PREVIEW: ImportPreviewResponse = {
  classification: {
    type: 'lift-records',
    confidence: 0.92,
    bucket: 'high',
    reasons: ['Matched required lift-record columns'],
    alternatives: [],
  },
  destination: 'lift-records',
  columnMappings: AMBIGUOUS_LIFT_COLUMN_MAPPINGS,
  preview: {
    creates: 0,
    updates: 0,
    skips: 0,
    deltas: [
      { key: '__ambiguous_1', label: 'Row 1', kind: 'create', status: 'ambiguous', rowIndex: 1, originalLift: '' },
      { key: '__ambiguous_2', label: 'Row 2', kind: 'create', status: 'ambiguous', rowIndex: 2, originalLift: '' },
    ],
  },
  errors: [],
};

const BLANK_LIFT_CELL_CSV = new File(
  [
    'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps\n' +
      '5-3-1,1,1,2026-01-01,,1,90,10\n' +
      '5-3-1,1,1,2026-01-01,,2,90,8',
  ],
  'lifts.csv',
  { type: 'text/csv' },
);

// A custom lift whose name is a lowercase case-variant of a canonical alias
// ("squat" vs. "Squat") — a distinct, genuinely reachable entry per
// buildEffectiveSlotMap's exact-case-only collision rule (#911 review, third
// pass regression fixture).
const CASE_VARIANT_CUSTOM_LIFT: CustomLiftResponse = {
  id: 'custom-lowercase-squat',
  name: 'squat',
  classification: 'compound',
  movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
  isBodyweightComponent: false,
  isCustom: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const CASE_VARIANT_PREVIEW: ImportPreviewResponse = {
  classification: {
    type: 'lift-records',
    confidence: 0.92,
    bucket: 'high',
    reasons: ['Matched required lift-record columns'],
    alternatives: [],
  },
  destination: 'lift-records',
  columnMappings: AMBIGUOUS_LIFT_COLUMN_MAPPINGS,
  preview: {
    creates: 0,
    updates: 0,
    skips: 0,
    deltas: [
      {
        key: '__ambiguous_1',
        label: 'Row 1: Some Unknown Lift',
        kind: 'create',
        status: 'ambiguous',
        rowIndex: 1,
        originalLift: 'Some Unknown Lift',
      },
    ],
  },
  errors: [],
};

const CASE_VARIANT_CSV = new File(
  [
    'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps\n' +
      '5-3-1,1,1,2026-01-01,Some Unknown Lift,1,90,10',
  ],
  'lifts.csv',
  { type: 'text/csv' },
);

describe('ImportWizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // #911 review, second pass: jest.clearAllMocks() (above) resets call
  // history but does NOT restore a jest.spyOn(console, 'error') mock — that
  // was previously only undone by errorSpy.mockRestore() at the end of the
  // one test using it, so any assertion failing before that line left
  // console.error permanently mocked for every later test in this file,
  // turning one real failure into a cascade of confusing, silently-swallowed
  // ones. jest.restoreAllMocks() here covers it (and any future spy)
  // unconditionally, regardless of where a test exits.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('walks Source → Classify → Review → Preview → Done for a confident classification', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);

    // REVIEW step shows the editable TM list.
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByLabelText('Weight for squat')).toBeInTheDocument();
    expect(screen.getByLabelText('Weight for bench')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview

    // PREVIEW step shows count pills.
    expect(screen.getByText('Preview changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit import' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Commit import' }));

    await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
    // Commit receives a rebuilt File for training-maxes.
    expect(mockCommit).toHaveBeenCalledWith(
      'prog-1',
      expect.any(File),
      'training-maxes',
      expect.anything(),
    );
  });

  // #911 review, tenth pass: the REVIEW-step error block had no coverage at
  // all — round 9 converted its bare `.slice(0, 20)` to the shared constant
  // and added an "N more" note, matching the two already-tested sites, but
  // itself went untested.
  it('REVIEW step shows a capped error list with a "more errors" indicator', async () => {
    const overflowCount = 5;
    const totalErrors = MAX_RENDERED_IMPORT_ERRORS + overflowCount;
    const user = userEvent.setup();
    mockPreview.mockResolvedValue({
      ...TM_PREVIEW,
      errors: Array.from({ length: totalErrors }, (_, i) => ({
        row: i + 1,
        field: 'weight',
        message: `Row ${i + 1} failed`,
      })),
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);

    expect(
      screen.getByText(`This file has ${totalErrors} problem(s):`),
    ).toBeInTheDocument();
    expect(screen.getByText(/Row 1\b/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`Row ${totalErrors}\\b`))).not.toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`…and ${overflowCount} more error\\(s\\) not shown\\.`)),
    ).toBeInTheDocument();
  });

  // #911 review, eighth pass: the commitErrors render path had no coverage at
  // all before this test — for any destination, not just training-maxes.
  // Asserts both the truncation itself and the "N more" indicator required
  // alongside it (without it, a user who fixes only the visible rows and
  // re-submits is rejected again with no warning more errors existed).
  it('shows a capped error list with a "more errors" indicator when commit fails', async () => {
    // Derived from MAX_RENDERED_IMPORT_ERRORS, not hardcoded — see the identical
    // rationale in LiftRecordsImportForm.test.tsx's sibling test (#911 review,
    // ninth pass).
    const overflowCount = 5;
    const totalErrors = MAX_RENDERED_IMPORT_ERRORS + overflowCount;
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: false,
      errors: Array.from({ length: totalErrors }, (_, i) => ({
        row: i + 1,
        message: `Row ${i + 1} failed`,
      })),
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);
    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    await user.click(screen.getByRole('button', { name: 'Commit import' }));

    await waitFor(() => expect(screen.getByText('Commit failed:')).toBeInTheDocument());
    expect(screen.getByText(/Row 1 failed/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`Row ${totalErrors} failed`))).not.toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`…and ${overflowCount} more error\\(s\\) not shown\\.`)),
    ).toBeInTheDocument();
  });

  it('training-maxes: edited weight in REVIEW is reflected in the commit payload', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);

    // Edit the squat weight from '300' to '325' in REVIEW.
    const weightInput = screen.getByLabelText('Weight for squat');
    await user.clear(weightInput);
    await user.type(weightInput, '325');

    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));

    const [, commitFile] = mockCommit.mock.calls[0] as [string, File, string];
    const text = await readFileText(commitFile);
    expect(text).toContain('squat');
    expect(text).toContain('325');
    expect(text).not.toContain(',300');
  });

  it('training-maxes: a decimal weight in REVIEW is not rounded in the commit payload', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);

    // Edit the squat weight to a value with 2.5/1.25-increment decimal precision.
    const weightInput = screen.getByLabelText('Weight for squat');
    await user.clear(weightInput);
    await user.type(weightInput, '316.25');

    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));

    const [, commitFile] = mockCommit.mock.calls[0] as [string, File, string];
    const text = await readFileText(commitFile);
    expect(text).toContain('316.25');
    expect(text).not.toContain(',316\n');
  });

  it('training-maxes: removed row in REVIEW is excluded from the commit payload', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 1, updated: 0, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);

    // Remove the bench row in REVIEW.
    await user.click(screen.getByRole('button', { name: 'Remove bench' }));
    // bench row should no longer be visible; squat should remain.
    expect(screen.queryByLabelText('Weight for bench')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Weight for squat')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));

    const [, commitFile] = mockCommit.mock.calls[0] as [string, File, string];
    const text = await readFileText(commitFile);
    expect(text).toContain('squat');
    expect(text).not.toContain('bench');
  });

  it('training-maxes: Back from PREVIEW preserves REVIEW weight edits', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);

    // Edit squat weight in REVIEW.
    const weightInput = screen.getByLabelText('Weight for squat');
    await user.clear(weightInput);
    await user.type(weightInput, '350');

    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    // Navigate back to REVIEW — edits must survive.
    await user.click(screen.getByRole('button', { name: 'Back' }));

    // The weight should still be '350', not reset to the original '300'.
    expect(screen.getByLabelText('Weight for squat')).toHaveValue(350);
  });

  // #911 review, tenth pass: a failed commit's error list previously survived a
  // Back → fix the named rows → Next round trip unchanged, contradicting the
  // very errors it named. Distinct from the round-8/9 truncation tests (which
  // only ever commit once) — this specifically exercises the two-attempt path.
  it('training-maxes: a stale "Commit failed" list does not survive Back → Next', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValueOnce({
      ok: false,
      errors: [{ row: 1, message: 'First attempt failed' }],
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);
    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    await user.click(screen.getByRole('button', { name: 'Commit import' }));

    await waitFor(() => expect(screen.getByText('Commit failed:')).toBeInTheDocument());
    expect(screen.getByText(/First attempt failed/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' })); // Preview → Review
    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview

    expect(screen.queryByText('Commit failed:')).not.toBeInTheDocument();
    expect(screen.queryByText(/First attempt failed/)).not.toBeInTheDocument();
  });

  it('training-maxes: Next is disabled in REVIEW when all rows are removed', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);

    // Remove both rows.
    await user.click(screen.getByRole('button', { name: 'Remove squat' }));
    await user.click(screen.getByRole('button', { name: 'Remove bench' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });
  });

  it('shows a manual destination picker when classification is low-confidence', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue({
      classification: { type: null, confidence: 0.4, bucket: 'low', reasons: [], alternatives: [] },
      destination: null,
      columnMappings: null,
      preview: null,
      errors: [],
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    const file = new File(['Foo,Bar\n1,2'], 'mystery.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('CSV file'), file);
    await user.click(screen.getByRole('button', { name: 'Analyze' }));

    await waitFor(() =>
      expect(screen.getByText(/couldn.t confidently tell/i)).toBeInTheDocument(),
    );
    // All four destinations are offered as manual picks.
    expect(screen.getByRole('button', { name: /Lift History/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Program/ })).toBeInTheDocument();
  });

  it('lift-records: DONE step lists per-row skip detail from skippedDetail (#891)', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(LIFT_RECORDS_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: {
        destination: 'lift-records',
        created: 0,
        updated: 0,
        skipped: 1,
        skippedDetail: [{ row: 1, naturalKey: '1:1:20260101:bench-press:1' }],
        batchId: 'batch-lr-1',
      },
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(
      ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps\n5-3-1,1,1,2026-01-01,Bench P.,1,180,5'],
      'lifts.csv',
      { type: 'text/csv' },
    );
    await commitLiftRecordsImport(user, file);

    expect(screen.getByText('0 created, 0 updated, 1 skipped.', { exact: false })).toBeInTheDocument();

    // Skipped-rows detail is behind a <details> disclosure — open it, then read the row.
    await user.click(screen.getByText('Skipped rows'));
    expect(screen.getByText(/Row 1: 1:1:20260101:bench-press:1/)).toBeInTheDocument();
  });

  // #911 review, ninth pass: skippedDetail had the identical unbounded-render
  // risk as the error lists (up to MAX_IMPORT_ROWS entries), fixed alongside
  // them but previously covered only by the single-item test above — this
  // adds coverage for the cap itself.
  it('lift-records: DONE step caps the skippedDetail list and shows a "more" indicator', async () => {
    const overflowCount = 5;
    const totalSkipped = MAX_RENDERED_IMPORT_SKIPS + overflowCount;
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(LIFT_RECORDS_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: {
        destination: 'lift-records',
        created: 0,
        updated: 0,
        skipped: totalSkipped,
        skippedDetail: Array.from({ length: totalSkipped }, (_, i) => ({
          row: i + 1,
          naturalKey: `1:1:20260101:bench-press:${i + 1}`,
        })),
        batchId: 'batch-lr-2',
      },
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);

    const file = new File(
      ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps\n5-3-1,1,1,2026-01-01,Bench P.,1,180,5'],
      'lifts.csv',
      { type: 'text/csv' },
    );
    await commitLiftRecordsImport(user, file);
    await user.click(screen.getByText('Skipped rows'));

    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_RENDERED_IMPORT_SKIPS);
    expect(screen.queryByText(new RegExp(`Row ${totalSkipped}:`))).not.toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`…and ${overflowCount} more skipped row\\(s\\) not shown\\.`)),
    ).toBeInTheDocument();
  });

  // #911 review, tenth pass: mirrors the error list's own "no indicator when
  // not capped" guard — without this, a `>` accidentally flipped to `>=`
  // would render "…and 0 more skipped row(s) not shown." with the rest of
  // the suite still green.
  it('lift-records: DONE step does not show a "more skipped rows" indicator when not capped', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(LIFT_RECORDS_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: {
        destination: 'lift-records',
        created: 0,
        updated: 0,
        skipped: 2,
        skippedDetail: [
          { row: 1, naturalKey: '1:1:20260101:bench-press:1' },
          { row: 2, naturalKey: '1:1:20260101:bench-press:2' },
        ],
        batchId: 'batch-lr-3',
      },
    });

    const file = new File(
      ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps\n5-3-1,1,1,2026-01-01,Bench P.,1,180,5'],
      'lifts.csv',
      { type: 'text/csv' },
    );
    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    await commitLiftRecordsImport(user, file);
    await user.click(screen.getByText('Skipped rows'));

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/more skipped row\(s\) not shown/)).not.toBeInTheDocument();
  });

  // #911: the REVIEW step's ambiguous-row remap datalist offers the user's
  // custom lifts alongside the built-in canonical ones, and an inline
  // "create new exercise" affordance for a genuinely unrecognized name.
  describe('ambiguous-row remap: custom lifts (#911)', () => {
    it("datalist includes the user's custom lifts alongside built-in canonical lifts", async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);

      const { container } = render(
        <ImportWizard programs={PROGRAMS} customLifts={[CUSTOM_LIFT]} />,
      );
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      const options = Array.from(container.querySelectorAll('#lift-catalog option')).map(
        (o) => (o as HTMLOptionElement).value,
      );
      expect(options).toContain('Wide-Grip CBL Curls');
      // A canonical *value* (id) — this alone would still pass against the
      // pre-fix CANONICAL_LIFT_IDS-only implementation, so it is NOT
      // sufficient proof of the fix by itself; the assertion below on a
      // canonical *key* (human-typed alias) is what actually distinguishes
      // ALL_SLOT_MAP_ALIASES from CANONICAL_LIFT_IDS (#911 review, second
      // pass — this test previously only asserted the former).
      expect(options).toContain('bench-press');
      expect(options).toContain('Squat');
    });

    // Regression guard (#911 review, second pass): this is the behavioral
    // proof the datalist-content assertion above can't fully provide —
    // CANONICAL_LIFT_IDS (values only) would have let this test fail here,
    // where the prior version of this describe block had no case that could.
    it('typing a canonical alias key (not just its id) does not surface "create new"', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      const input = screen.getByLabelText('Lift name for row 1');
      await user.clear(input);
      await user.type(input, 'Squat');

      // Scoped to row 1's own <tr>: AMBIGUOUS_LIFT_PREVIEW has two ambiguous
      // rows sharing the same original text, so row 2's untouched "No match"
      // prompt is still in the document — a page-wide query would find it and
      // falsely pass regardless of whether row 1's own state updated.
      const row = input.closest('tr');
      expect(row).not.toBeNull();
      expect(within(row!).queryByText(/No match — create/i)).not.toBeInTheDocument();
    });

    it('typing a lowercase/case-variant of a canonical alias does not surface "create new"', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      const input = screen.getByLabelText('Lift name for row 1');
      await user.clear(input);
      await user.type(input, 'squat');

      // Scoped to row 1's own <tr> — see comment in the sibling test above.
      const row = input.closest('tr');
      expect(row).not.toBeNull();
      expect(within(row!).queryByText(/No match — create/i)).not.toBeInTheDocument();
    });

    it('does not show "create new" when a row already matches an existing custom lift by name', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);

      render(<ImportWizard programs={PROGRAMS} customLifts={[CUSTOM_LIFT]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      // Both rows' original text already exactly matches CUSTOM_LIFT.name.
      expect(screen.queryByText(/No match — create/i)).not.toBeInTheDocument();
    });

    it('surfaces "create new" for a genuinely unrecognized name, disabled until a classification is chosen', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      const prompts = screen.getAllByText(
        'No match — create "Wide-Grip CBL Curls" as a new exercise',
      );
      expect(prompts).toHaveLength(2); // both ambiguous rows share the same original text

      const createButtons = screen.getAllByRole('button', {
        name: 'Create "Wide-Grip CBL Curls" as a new exercise',
      });
      expect(createButtons[0]).toBeDisabled();

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      expect(createButtons[0]).toBeEnabled();
    });

    it('creates a new exercise and batch-resolves every row sharing the same original text', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);
      mockCommit.mockResolvedValue({
        ok: true,
        data: { destination: 'lift-records', created: 2, updated: 0, skipped: 0, batchId: 'batch-cbl' },
      });
      mockCreateCustomLift.mockResolvedValue(CUSTOM_LIFT);

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      const createButtons = screen.getAllByRole('button', {
        name: 'Create "Wide-Grip CBL Curls" as a new exercise',
      });
      await user.click(createButtons[0]!);

      await waitFor(() =>
        expect(mockCreateCustomLift).toHaveBeenCalledWith({
          name: 'Wide-Grip CBL Curls',
          classification: 'accessory',
        }),
      );
      // Only one creation call — the second row resolves via batch-matching, not a second create.
      expect(mockCreateCustomLift).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByText(/No match — create/i)).not.toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
      await user.click(screen.getByRole('button', { name: 'Commit import' }));
      await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));

      const [, , , opts] = mockCommit.mock.calls[0] as [
        string,
        File,
        string,
        { liftOverrides?: Record<number, string> },
      ];
      expect(opts.liftOverrides).toEqual({ 1: 'custom-cbl-curls', 2: 'custom-cbl-curls' });
    });

    it('shows an inline error when creation 409s with no local match to self-heal against', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);
      mockCreateCustomLift.mockResolvedValue(null);
      // A genuinely successful refetch that still finds no matching name —
      // the "confirmed not found" branch, distinct from the refetch-failed
      // branch covered by the sibling test below (#911 review, second pass:
      // this test previously left fetchCustomLifts entirely unmocked, so it
      // was silently exercising the refetch-*failed* path by accident — both
      // branches' messages happen to contain "already exists", which is why
      // the original loose regex assertion never caught it).
      mockFetchCustomLifts.mockResolvedValue([]);

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      const createButtons = screen.getAllByRole('button', {
        name: 'Create "Wide-Grip CBL Curls" as a new exercise',
      });
      await user.click(createButtons[0]!);

      // #911 review, eighth pass: this message deliberately does not assert
      // "already exists" unconditionally — a 409 with no local match could
      // also be a reserved-name collision, not just a genuine duplicate.
      expect(
        await screen.findByText("This name can't be used — it already exists or is reserved."),
      ).toBeInTheDocument();
      expect(mockFetchCustomLifts).toHaveBeenCalledTimes(1);
    });

    it('shows a distinct inline error when the 409 self-heal refetch itself fails', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);
      mockCreateCustomLift.mockResolvedValue(null);
      const fetchFailure = new Error('API 500 Internal Server Error for /lifts/custom');
      mockFetchCustomLifts.mockRejectedValue(fetchFailure);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      const createButtons = screen.getAllByRole('button', {
        name: 'Create "Wide-Grip CBL Curls" as a new exercise',
      });
      await user.click(createButtons[0]!);

      // "Couldn't confirm" — not "already exists" — since the refetch failing
      // is not the same claim as a genuine name collision (#911 review).
      expect(
        await screen.findByText("Couldn't confirm whether this name already exists — try again."),
      ).toBeInTheDocument();
      // Context is { programId, rowIndex } only — no `name`, matching the
      // createCustomLift-throws logging contract above.
      expect(errorSpy).toHaveBeenCalledWith(
        '[client-mutation] fetchCustomLifts failed',
        fetchFailure,
        { programId: 'prog-1', rowIndex: 1 },
      );
    });

    it('logs and shows an inline error when creation throws', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);
      const failure = new Error('API 500 Internal Server Error for /lifts/custom');
      mockCreateCustomLift.mockRejectedValue(failure);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      const createButtons = screen.getAllByRole('button', {
        name: 'Create "Wide-Grip CBL Curls" as a new exercise',
      });
      await user.click(createButtons[0]!);

      // Context is { programId, rowIndex } only — no `name`/raw CSV text, per
      // the #911 review privacy fix (logClientError must never beacon raw
      // user-typed exercise names to Grafana).
      await waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          '[client-mutation] createCustomLift failed',
          failure,
          { programId: 'prog-1', rowIndex: 1 },
        ),
      );
      expect(await screen.findByText(failure.message)).toBeInTheDocument();
      errorSpy.mockRestore();
    });

    it('does not batch-resolve an unrelated blank-cell row when creating from another blank-cell row', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(BLANK_LIFT_CELL_PREVIEW);
      mockCommit.mockResolvedValue({
        ok: true,
        data: { destination: 'lift-records', created: 1, updated: 0, skipped: 0, batchId: 'batch-blank' },
      });
      mockCreateCustomLift.mockResolvedValue({
        id: 'custom-new-blank-lift',
        name: 'New Lift',
        classification: 'accessory',
        movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
        isBodyweightComponent: false,
        isCustom: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, BLANK_LIFT_CELL_CSV);

      // Type a name into row 1 only — row 2 stays untouched/blank, sharing
      // nothing with row 1 except the accidental '' === '' both blank cells
      // parse to.
      const row1Input = screen.getByLabelText('Lift name for row 1');
      await user.type(row1Input, 'New Lift');

      const createButtons = screen.getAllByRole('button', {
        name: 'Create "New Lift" as a new exercise',
      });
      expect(createButtons).toHaveLength(1); // row 2 shows no affordance — still blank
      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      await user.click(createButtons[0]!);
      await waitFor(() => expect(mockCreateCustomLift).toHaveBeenCalledTimes(1));

      await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
      await user.click(screen.getByRole('button', { name: 'Commit import' }));
      await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));

      const [, , , opts] = mockCommit.mock.calls[0] as [
        string,
        File,
        string,
        { liftOverrides?: Record<number, string> },
      ];
      // Row 2 must NOT be swept into row 1's override — before the fix, both
      // blank cells' originalLift === '' matched each other, silently
      // assigning row 2 to whatever row 1 resolved to.
      expect(opts.liftOverrides).toEqual({ 1: 'custom-new-blank-lift' });
    });

    it('does not batch-resolve a row the user has explicitly excluded', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(AMBIGUOUS_LIFT_PREVIEW);
      mockCommit.mockResolvedValue({
        ok: true,
        data: { destination: 'lift-records', created: 1, updated: 0, skipped: 0, batchId: 'batch-excl' },
      });
      mockCreateCustomLift.mockResolvedValue(CUSTOM_LIFT);

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, AMBIGUOUS_LIFT_CSV);

      // Exclude row 2 before creating from row 1 — both rows share the same
      // original text, so row 2 would otherwise be a valid batch-resolve target.
      await user.click(screen.getByRole('button', { name: 'Exclude Row 2: Wide-Grip CBL Curls' }));

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      const createButtons = screen.getAllByRole('button', {
        name: 'Create "Wide-Grip CBL Curls" as a new exercise',
      });
      await user.click(createButtons[0]!);
      await waitFor(() => expect(mockCreateCustomLift).toHaveBeenCalledTimes(1));

      await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
      await user.click(screen.getByRole('button', { name: 'Commit import' }));
      await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));

      const [, , , opts] = mockCommit.mock.calls[0] as [
        string,
        File,
        string,
        { liftOverrides?: Record<number, string> },
      ];
      // Row 2 was explicitly excluded — it must not receive the batch-resolved
      // override even though it shares row 1's original text.
      expect(opts.liftOverrides).toEqual({ 1: 'custom-cbl-curls' });
    });

    it('resolves an exact-case match to a custom lift over a case-insensitive canonical fallback', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(CASE_VARIANT_PREVIEW);
      mockCommit.mockResolvedValue({
        ok: true,
        data: { destination: 'lift-records', created: 1, updated: 0, skipped: 0, batchId: 'batch-case' },
      });

      render(<ImportWizard programs={PROGRAMS} customLifts={[CASE_VARIANT_CUSTOM_LIFT]} />);
      await navigateToLiftRecordsReview(user, CASE_VARIANT_CSV);

      const input = screen.getByLabelText('Lift name for row 1');
      await user.clear(input);
      await user.type(input, 'squat');

      // Resolves without offering to create a duplicate — 'squat' is known,
      // either as the custom lift itself or case-insensitively as 'Squat'.
      expect(screen.queryByText(/No match — create/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
      await user.click(screen.getByRole('button', { name: 'Commit import' }));
      await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));

      const [, , , opts] = mockCommit.mock.calls[0] as [
        string,
        File,
        string,
        { liftOverrides?: Record<number, string> },
      ];
      // Must resolve to the exact-case custom lift's own name ('squat'), not
      // the case-insensitively-matched canonical alias ('Squat') —
      // buildEffectiveSlotMap only lets DEFAULT_SLOT_MAP win on an EXACT-case
      // collision, so 'squat' is a distinct, genuinely reachable server-side
      // key for the custom lift, not a duplicate of canonical Squat.
      expect(opts.liftOverrides).toEqual({ 1: 'squat' });
    });

    it('does not disable an unrelated row\'s Create button while a different row (sharing no name) is busy', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(BLANK_LIFT_CELL_PREVIEW); // two rows, both originalLift === ''
      // Never resolves — row 1's create stays "busy" for the whole test, the
      // state under test.
      mockCreateCustomLift.mockReturnValue(new Promise(() => {}));

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, BLANK_LIFT_CELL_CSV);

      // Both rows are blank cells (originalLift === '' for both) but the user
      // types two DIFFERENT new names into them — the exact case the
      // originalLift-keyed guard (round 3) over-blocked, since both rows
      // shared the same (empty) originalLift despite being unrelated (#911
      // review, fourth pass).
      await user.type(screen.getByLabelText('Lift name for row 1'), 'First New Lift');
      await user.type(screen.getByLabelText('Lift name for row 2'), 'Second New Lift');

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      const row1Create = screen.getByRole('button', { name: 'Create "First New Lift" as a new exercise' });
      await user.click(row1Create);
      await waitFor(() => expect(row1Create).toBeDisabled()); // row 1 now busy

      // Row 2's own Create button must still be reachable — it needs its own
      // classification pick first (each row's chip state is independent).
      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[1]!);
      const row2Create = screen.getByRole('button', { name: 'Create "Second New Lift" as a new exercise' });
      expect(row2Create).toBeEnabled();
    });

    it('disables a different row\'s Create button while a busy row is creating the SAME name', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(BLANK_LIFT_CELL_PREVIEW);
      mockCreateCustomLift.mockReturnValue(new Promise(() => {})); // never resolves

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, BLANK_LIFT_CELL_CSV);

      // Two rows sharing NO original text (both blank), retyped to the SAME
      // new name — a genuine duplicate-create risk this guard exists to
      // prevent, and must still catch even though these rows don't share
      // originalLift (#911 review, fourth pass).
      await user.type(screen.getByLabelText('Lift name for row 1'), 'Same New Lift');
      await user.type(screen.getByLabelText('Lift name for row 2'), 'Same New Lift');

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      const createButtons = screen.getAllByRole('button', {
        name: 'Create "Same New Lift" as a new exercise',
      });
      await user.click(createButtons[0]!);
      await waitFor(() => expect(createButtons[0]).toBeDisabled());

      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[1]!);
      expect(createButtons[1]).toBeDisabled();
    });

    // Regression guard (#911 review, fifth AND sixth passes): fifth pass
    // added draft?.busy to the Create button's own disabled check (the row's
    // own in-flight state must disable its button even though busyLiftNames
    // is keyed by submitted name, not row). Sixth pass found that guard was
    // only a partial fix: the remap <input> itself was still editable while
    // busy, so applyResolvedLiftToMatchingRows' unconditional
    // triggering-row write would silently clobber a value the user retyped
    // mid-flight even with the button correctly disabled. Now the input is
    // disabled too, which structurally prevents the retype (and the clobber)
    // rather than just disabling the button around it.
    it('disables both the row\'s own Create button and its remap input while its create is in flight', async () => {
      const user = userEvent.setup();
      mockPreview.mockResolvedValue(BLANK_LIFT_CELL_PREVIEW);
      mockCreateCustomLift.mockReturnValue(new Promise(() => {})); // never resolves

      render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
      await navigateToLiftRecordsReview(user, BLANK_LIFT_CELL_CSV);

      const row1Input = screen.getByLabelText('Lift name for row 1');
      await user.type(row1Input, 'First Attempt');
      await user.click(screen.getAllByRole('button', { name: 'Accessory' })[0]!);
      const firstCreateButton = screen.getByRole('button', {
        name: 'Create "First Attempt" as a new exercise',
      });
      await user.click(firstCreateButton);

      await waitFor(() => expect(firstCreateButton).toBeDisabled());
      expect(row1Input).toBeDisabled();
    });
  });

  it('training-maxes: DONE step has no skipped-rows disclosure when skippedDetail is absent', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} customLifts={[]} />);
    const file = new File(['Date Updated,Lift,Weight\n1/1/2026,Squat,300'], 'tm.csv', {
      type: 'text/csv',
    });
    await navigateToReview(user, file);
    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    await user.click(screen.getByRole('button', { name: 'Commit import' }));

    await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
    expect(screen.queryByText('Skipped rows')).not.toBeInTheDocument();
  });
});
