import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomProgramSummaryResponse, ImportPreviewResponse } from '@lifting-logbook/types';
import { ImportWizard } from './ImportWizard';
import { commitImport, previewImport } from '@/lib/client-api';

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
}));

const mockPreview = previewImport as jest.MockedFunction<typeof previewImport>;
const mockCommit = commitImport as jest.MockedFunction<typeof commitImport>;

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

describe('ImportWizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('walks Source → Classify → Review → Preview → Done for a confident classification', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} />);

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

  it('training-maxes: edited weight in REVIEW is reflected in the commit payload', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} />);

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

    render(<ImportWizard programs={PROGRAMS} />);

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

    render(<ImportWizard programs={PROGRAMS} />);

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

    render(<ImportWizard programs={PROGRAMS} />);

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

  it('training-maxes: Next is disabled in REVIEW when all rows are removed', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);

    render(<ImportWizard programs={PROGRAMS} />);

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

    render(<ImportWizard programs={PROGRAMS} />);
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

    render(<ImportWizard programs={PROGRAMS} />);

    const file = new File(
      ['Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps\n5-3-1,1,1,2026-01-01,Bench P.,1,180,5'],
      'lifts.csv',
      { type: 'text/csv' },
    );
    await user.upload(screen.getByLabelText('CSV file'), file);
    await user.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(screen.getByText('Lift History')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' })); // Classify → Map
    await user.click(screen.getByRole('button', { name: 'Next' })); // Map → Review
    await user.click(screen.getByRole('button', { name: 'Next' })); // Review → Preview
    await user.click(screen.getByRole('button', { name: 'Commit import' }));

    await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
    expect(screen.getByText('0 created, 0 updated, 1 skipped.', { exact: false })).toBeInTheDocument();

    // Skipped-rows detail is behind a <details> disclosure — open it, then read the row.
    await user.click(screen.getByText('Skipped rows'));
    expect(screen.getByText(/Row 1: 1:1:20260101:bench-press:1/)).toBeInTheDocument();
  });

  it('training-maxes: DONE step has no skipped-rows disclosure when skippedDetail is absent', async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TM_PREVIEW);
    mockCommit.mockResolvedValue({
      ok: true,
      data: { destination: 'training-maxes', created: 2, updated: 1, skipped: 0, batchId: 'batch-1' },
    });

    render(<ImportWizard programs={PROGRAMS} />);
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
