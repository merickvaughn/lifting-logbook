import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TrainingMaxImportBatchSummary } from '@lifting-logbook/types';
import { undoImport } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import TrainingMaxImports from './TrainingMaxImports';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('@/lib/client-api', () => ({ undoImport: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/calendarDay', () => ({ localToday: () => '2026-11-22' }));
const mockUndo = undoImport as jest.MockedFunction<typeof undoImport>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

const NEWER: TrainingMaxImportBatchSummary = { id: 'tm-new', program: '5-3-1', createdAt: '2026-11-21T18:04:09.000Z' };
const OLDER: TrainingMaxImportBatchSummary = { id: 'tm-old', program: '5-3-1', createdAt: '2026-11-20T09:30:00.000Z' };

describe('TrainingMaxImports (#1405)', () => {
  beforeEach(() => {
    mockUndo.mockReset();
    mockLog.mockReset();
    refresh.mockReset();
  });

  it('renders nothing when there is no import to undo', () => {
    const { container } = render(<TrainingMaxImports imports={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each import with its own Undo', () => {
    render(<TrainingMaxImports imports={[NEWER, OLDER]} />);
    expect(screen.getByRole('heading', { name: 'Imported training maxes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo the import of 2026-11-21 18:04 UTC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo the import of 2026-11-20 09:30 UTC' })).toBeInTheDocument();
  });

  it("asks first, then undoes the batch by its program and ID and shows the restored count", async () => {
    const user = userEvent.setup();
    mockUndo.mockResolvedValue({ batchId: 'tm-old', restored: 10, skipped: 0, flagged: [] });
    render(<TrainingMaxImports imports={[NEWER, OLDER]} />);

    await user.click(screen.getByRole('button', { name: 'Undo the import of 2026-11-20 09:30 UTC' }));
    expect(mockUndo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Undo import' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Undo import' }));

    expect(await screen.findByText('Undo complete: 10 restored.')).toHaveFocus();
    expect(mockUndo).toHaveBeenCalledWith('5-3-1', 'tm-old', '2026-11-22');
    expect(refresh).toHaveBeenCalled();
  });

  it('shows what was skipped and flagged', async () => {
    const user = userEvent.setup();
    mockUndo.mockResolvedValue({
      batchId: 'tm-new',
      restored: 1,
      skipped: 1,
      flagged: [{ key: 'bench-press', reason: 'weight modified after import (expected 185, found 190)' }],
    });
    render(<TrainingMaxImports imports={[NEWER]} />);

    await user.click(screen.getByRole('button', { name: 'Undo the import of 2026-11-21 18:04 UTC' }));
    await user.click(screen.getByRole('button', { name: 'Undo import' }));

    expect(await screen.findByText('Undo complete: 1 restored, 1 skipped, 1 flagged (modified since import).')).toBeInTheDocument();
  });

  it('does nothing on Cancel, returning focus to the Undo button', async () => {
    const user = userEvent.setup();
    render(<TrainingMaxImports imports={[NEWER]} />);

    await user.click(screen.getByRole('button', { name: 'Undo the import of 2026-11-21 18:04 UTC' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockUndo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Undo the import of 2026-11-21 18:04 UTC' })).toHaveFocus();
  });

  it('runs one undo at a time', async () => {
    const user = userEvent.setup();
    let finish: (value: { batchId: string; restored: number; skipped: number; flagged: [] }) => void = () => {};
    mockUndo.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<TrainingMaxImports imports={[NEWER, OLDER]} />);

    await user.click(screen.getByRole('button', { name: 'Undo the import of 2026-11-21 18:04 UTC' }));
    await user.click(screen.getByRole('button', { name: 'Undo import' }));

    expect(screen.getByRole('button', { name: 'Undo the import of 2026-11-20 09:30 UTC' })).toBeDisabled();
    finish({ batchId: 'tm-new', restored: 1, skipped: 0, flagged: [] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Undo the import of 2026-11-20 09:30 UTC' })).toBeEnabled(),
    );
  });

  it('shows and reports a failed undo', async () => {
    const user = userEvent.setup();
    const failure = new Error('Undo import failed (HTTP 500)');
    mockUndo.mockRejectedValue(failure);
    render(<TrainingMaxImports imports={[NEWER]} />);

    await user.click(screen.getByRole('button', { name: 'Undo the import of 2026-11-21 18:04 UTC' }));
    await user.click(screen.getByRole('button', { name: 'Undo import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Undo import failed (HTTP 500)');
    expect(mockLog).toHaveBeenCalledWith('undoImport', failure, { programId: '5-3-1', batchId: 'tm-new' });
    expect(refresh).not.toHaveBeenCalled();
    // The confirm button was disabled while the undo ran; focus comes back to it for a retry.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo import' })).toHaveFocus());
  });

  it('says Undo is unavailable when the list could not be read', () => {
    render(<TrainingMaxImports imports={[]} failed />);
    expect(screen.getByRole('heading', { name: 'Imported training maxes' })).toBeInTheDocument();
    expect(screen.getByText(/Undoing a training-max import isn’t available right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('announces the outcome in a status region mounted before it appears', async () => {
    const user = userEvent.setup();
    mockUndo.mockResolvedValue({ batchId: 'tm-new', restored: 2, skipped: 0, flagged: [] });
    render(<TrainingMaxImports imports={[NEWER]} />);
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();

    await user.click(screen.getByRole('button', { name: 'Undo the import of 2026-11-21 18:04 UTC' }));
    await user.click(screen.getByRole('button', { name: 'Undo import' }));

    await waitFor(() => expect(status).toHaveTextContent('Undo complete: 2 restored.'));
  });
});
