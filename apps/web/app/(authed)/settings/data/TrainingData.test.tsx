import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClientError } from '@lifting-logbook/api-client';
import type { DataSnapshotSummary, TrainingDataCounts } from '@lifting-logbook/types';
import TrainingData from './TrainingData';
import {
  clearTrainingData,
  deleteSnapshot,
  downloadSnapshotLiftRecords,
  fetchSnapshotLiftRecordParts,
  fetchSnapshots,
  fetchTrainingDataCounts,
  restoreSnapshot,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

jest.mock('@/lib/client-api', () => ({
  clearTrainingData: jest.fn(),
  deleteSnapshot: jest.fn(),
  downloadSnapshotLiftRecords: jest.fn(),
  fetchSnapshotLiftRecordParts: jest.fn(),
  fetchSnapshots: jest.fn(),
  fetchTrainingDataCounts: jest.fn(),
  restoreSnapshot: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const NONE: TrainingDataCounts = {
  liftRecords: 0,
  macrocycles: 0,
  macrocycleDashboards: 0,
  macrocycleScheduledWorkouts: 0,
  trainingMaxes: 0,
  trainingMaxHistory: 0,
  liftModificationMaxes: 0,
  workoutDateOverrides: 0,
  workoutSkipOverrides: 0,
  workoutLiftOverrides: 0,
  focusDayStates: 0,
  importBatches: 0,
};
const counts: TrainingDataCounts = { ...NONE, liftRecords: 1_200, macrocycles: 3, trainingMaxes: 1 };
const snapshot: DataSnapshotSummary = {
  id: 'snap-1',
  kind: 'clear',
  createdAt: '2026-11-01T12:00:00.000Z',
  expiresAt: '2026-12-01T12:00:00.000Z',
  counts,
};

describe('Settings → Data → Clear data and backups', () => {
  let confirm: jest.SpyInstance;
  let click: jest.SpyInstance;
  const saved: string[] = [];
  const { createObjectURL, revokeObjectURL } = URL;

  beforeEach(() => {
    jest.clearAllMocks();
    saved.length = 0;
    (fetchSnapshots as jest.Mock).mockResolvedValue([]);
    (fetchTrainingDataCounts as jest.Mock).mockResolvedValue(counts);
    confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    URL.createObjectURL = jest.fn(() => 'blob:backup');
    URL.revokeObjectURL = jest.fn();
    click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
  });

  afterEach(() => {
    confirm.mockRestore();
    click.mockRestore();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it('shows the counts and the 30-day notice, and clears only once confirmed', async () => {
    const user = userEvent.setup();
    (clearTrainingData as jest.Mock).mockResolvedValue({ snapshot });
    render(<TrainingData />);

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));

    const panel = await screen.findByRole('group', { name: 'Clear 1,204 rows?' });
    expect(within(panel).getByText('1,200 logged sets')).toBeInTheDocument();
    expect(within(panel).getByText('3 macrocycles')).toBeInTheDocument();
    expect(within(panel).getByText('1 training max')).toBeInTheDocument();
    expect(within(panel).queryByText(/program dashboard/)).not.toBeInTheDocument();
    expect(panel).toHaveTextContent('kept for 30 days');
    expect(screen.getByRole('heading', { name: 'Clear 1,204 rows?' })).toHaveFocus();
    expect(clearTrainingData).not.toHaveBeenCalled();

    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    await user.click(within(panel).getByRole('button', { name: 'Clear 1,204 rows' }));

    expect(clearTrainingData).toHaveBeenCalledWith(counts);
    expect(await screen.findByRole('status')).toHaveTextContent('Cleared 1,204 rows. The backup is kept until');
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(await screen.findByText(/From clearing your data on/)).toBeInTheDocument();
  });

  it('changes nothing when cancelled', async () => {
    const user = userEvent.setup();
    render(<TrainingData />);

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(clearTrainingData).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Clear training data…' })).toHaveFocus();
  });

  it('returns focus to the Clear button once a clear has finished', async () => {
    const user = userEvent.setup();
    (clearTrainingData as jest.Mock).mockResolvedValue({ snapshot });
    render(<TrainingData />);

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));
    await user.click(await screen.findByRole('button', { name: 'Clear 1,204 rows' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear training data…' })).toHaveFocus());
  });

  it('returns focus to the Clear button while the backups are still being re-read', async () => {
    const user = userEvent.setup();
    (clearTrainingData as jest.Mock).mockResolvedValue({ snapshot });
    render(<TrainingData />);
    await waitFor(() => expect(fetchSnapshots).toHaveBeenCalledTimes(1));
    (fetchSnapshots as jest.Mock).mockReturnValue(new Promise(() => {}));

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));
    await user.click(await screen.findByRole('button', { name: 'Clear 1,204 rows' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear training data…' })).toHaveFocus());
    expect(fetchSnapshots).toHaveBeenCalledTimes(2);
  });

  // jsdom keeps focus on a disabled button, so these assert the button is never disabled: a
  // browser would move focus to the page's body. e2e/settings.spec.ts checks focus in Chromium.
  it('keeps the confirm button focusable while a clear runs, and focused after it fails', async () => {
    const user = userEvent.setup();
    let fail: (err: Error) => void = () => {};
    (clearTrainingData as jest.Mock).mockReturnValue(new Promise((_, reject) => (fail = reject)));
    render(<TrainingData />);

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));
    await user.click(await screen.findByRole('button', { name: 'Clear 1,204 rows' }));
    const clearing = screen.getByRole('button', { name: 'Clearing…' });
    expect(clearing).toHaveAttribute('aria-disabled', 'true');
    expect(clearing).not.toBeDisabled();
    await user.click(clearing);
    expect(clearTrainingData).toHaveBeenCalledTimes(1);

    fail(new Error('Couldn’t clear your training data.'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear 1,204 rows' })).toHaveFocus();
  });

  it('keeps the Clear button focusable while counting, and says a slow count cleared nothing', async () => {
    const user = userEvent.setup();
    let fail: (err: Error) => void = () => {};
    (fetchTrainingDataCounts as jest.Mock).mockReturnValue(new Promise((_, reject) => (fail = reject)));
    render(<TrainingData />);

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));
    expect(screen.getByRole('button', { name: 'Counting…' })).not.toBeDisabled();

    fail(new DOMException('The operation timed out.', 'TimeoutError'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('nothing was cleared');
    expect(alert).not.toHaveTextContent('may or may not');
    expect(screen.getByRole('button', { name: 'Clear training data…' })).toHaveFocus();
  });

  it('ignores the other backup buttons while one is running', async () => {
    const user = userEvent.setup();
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    (restoreSnapshot as jest.Mock).mockReturnValue(new Promise(() => {}));
    render(<TrainingData />);

    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(screen.getByRole('button', { name: 'Restoring…' })).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Download sets' }));

    expect(confirm).not.toHaveBeenCalled();
    expect(deleteSnapshot).not.toHaveBeenCalled();
    expect(fetchSnapshotLiftRecordParts).not.toHaveBeenCalled();
  });

  it('says a backup’s sets that took too long to read changed nothing', async () => {
    const user = userEvent.setup();
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    (fetchSnapshotLiftRecordParts as jest.Mock).mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    render(<TrainingData />);

    await user.click(await screen.findByRole('button', { name: 'Download sets' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Reading this backup’s sets took too long');
    expect(alert).not.toHaveTextContent('may or may not');
  });

  it('says a clear the browser stopped waiting for may have finished, and re-reads the backups', async () => {
    const user = userEvent.setup();
    (clearTrainingData as jest.Mock).mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    render(<TrainingData />);
    await waitFor(() => expect(fetchSnapshots).toHaveBeenCalledTimes(1));
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));
    await user.click(await screen.findByRole('button', { name: 'Clear 1,204 rows' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have finished');
    expect(fetchSnapshots).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/From clearing your data on/)).toBeInTheDocument();
  });

  it('says there’s nothing to clear when every count is zero', async () => {
    const user = userEvent.setup();
    (fetchTrainingDataCounts as jest.Mock).mockResolvedValue(NONE);
    render(<TrainingData />);

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));

    expect(await screen.findByRole('heading', { name: 'There’s nothing to clear' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Clear \d/ })).not.toBeInTheDocument();
  });

  it('shows the current counts when they changed before the clear ran', async () => {
    const user = userEvent.setup();
    const now = { ...counts, liftRecords: 1_201 };
    const changed = new ApiClientError('Your data has changed since you confirmed what to clear.', 409, 'counts-changed', {
      code: 'counts-changed',
      counts: now,
    });
    (clearTrainingData as jest.Mock).mockRejectedValue(changed);
    render(<TrainingData />);
    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));

    await user.click(await screen.findByRole('button', { name: 'Clear 1,204 rows' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your data has changed');
    expect(screen.getByRole('button', { name: 'Clear 1,205 rows' })).toBeInTheDocument();
    expect(logClientError).toHaveBeenCalledTimes(1);
    expect(logClientError).toHaveBeenCalledWith('clearTrainingData', changed);
  });

  it.each([
    ['clear', 'clearTrainingData', clearTrainingData, async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Clear training data…' }));
      await user.click(await screen.findByRole('button', { name: 'Clear 1,204 rows' }));
    }, undefined],
    ['restore', 'restoreSnapshot', restoreSnapshot, async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole('button', { name: 'Restore' }));
    }, { snapshot: 'snap-1' }],
    ['delete', 'deleteSnapshot', deleteSnapshot, async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole('button', { name: 'Delete' }));
    }, { snapshot: 'snap-1' }],
  ])('shows and logs once a failed %s', async (_name, op, endpoint, act, context) => {
    const user = userEvent.setup();
    const failure = new Error('Server said no');
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    (endpoint as jest.Mock).mockRejectedValue(failure);
    render(<TrainingData />);

    await act(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Server said no');
    expect(logClientError).toHaveBeenCalledTimes(1);
    expect(logClientError).toHaveBeenCalledWith(op, failure, ...(context ? [context] : []));
  });

  it('restores a backup and re-reads the list', async () => {
    const user = userEvent.setup();
    (fetchSnapshots as jest.Mock).mockResolvedValueOnce([snapshot]).mockResolvedValueOnce([]);
    (restoreSnapshot as jest.Mock).mockResolvedValue({ restored: { ...counts, liftRecords: 1_100 } });
    render(<TrainingData />);

    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(restoreSnapshot).toHaveBeenCalledWith('snap-1');
    expect(await screen.findByRole('status')).toHaveTextContent('Restored 1,104 rows.');
    expect(await screen.findByText(/No backups/)).toBeInTheDocument();
    // The Restore button left with its backup.
    expect(screen.getByRole('heading', { name: 'Backups' })).toHaveFocus();
  });

  it('leaves focus where the lifter moved it while a restore ran', async () => {
    const user = userEvent.setup();
    let finish: (value: { restored: TrainingDataCounts }) => void = () => {};
    (fetchSnapshots as jest.Mock).mockResolvedValueOnce([snapshot]).mockResolvedValueOnce([]);
    (restoreSnapshot as jest.Mock).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<TrainingData />);

    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    const clear = screen.getByRole('button', { name: 'Clear training data…' });
    clear.focus();
    finish({ restored: counts });

    expect(await screen.findByText(/No backups/)).toBeInTheDocument();
    expect(clear).toHaveFocus();
  });

  it('leaves focus where the lifter moved it while a clear ran', async () => {
    const user = userEvent.setup();
    let finish: (value: { snapshot: DataSnapshotSummary }) => void = () => {};
    (clearTrainingData as jest.Mock).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    render(<TrainingData />);

    await user.click(screen.getByRole('button', { name: 'Clear training data…' }));
    await user.click(await screen.findByRole('button', { name: 'Clear 1,204 rows' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // A control outside the confirmation, which a lifter could tab to while the clear runs.
    const restore = screen.getByRole('button', { name: 'Restore' });
    restore.focus();
    finish({ snapshot });

    expect(await screen.findByRole('status')).toHaveTextContent('Cleared');
    expect(cancel).not.toBeInTheDocument();
    expect(restore).toHaveFocus();
  });

  it('starts a backup’s new listing without the old listing’s part error', async () => {
    const user = userEvent.setup();
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    (fetchSnapshotLiftRecordParts as jest.Mock).mockResolvedValue({
      rows: 1_200,
      split: 'fedcba9876543210',
      parts: [{ part: 1, rows: 1_200, from: '2024-01-01', to: '2026-10-30' }],
    });
    (downloadSnapshotLiftRecords as jest.Mock).mockRejectedValue(new Error('List the parts again and download each one.'));
    render(<TrainingData />);

    await user.click(await screen.findByRole('button', { name: 'Download sets' }));
    const buttons = await screen.findAllByRole('button', { name: 'Download sets' });
    await user.click(buttons[buttons.length - 1] as HTMLElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('List the parts again');

    // The backup's own button lists the parts again.
    await user.click(screen.getAllByRole('button', { name: 'Download sets' })[0] as HTMLElement);

    await waitFor(() => expect(fetchSnapshotLiftRecordParts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('keeps focus on a backup’s button when a failed restore leaves it in the list', async () => {
    const user = userEvent.setup();
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    (restoreSnapshot as jest.Mock).mockRejectedValue(new Error('Couldn’t restore this backup.'));
    render(<TrainingData />);

    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toHaveFocus());
  });

  it('downloads a backup’s sets', async () => {
    const user = userEvent.setup();
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    (fetchSnapshotLiftRecordParts as jest.Mock).mockResolvedValue({
      rows: 1_200,
      split: 'fedcba9876543210',
      parts: [{ part: 1, rows: 1_200, from: '2024-01-01', to: '2026-10-30' }],
    });
    (downloadSnapshotLiftRecords as jest.Mock).mockResolvedValue(new Blob(['csv']));
    render(<TrainingData />);

    await user.click(await screen.findByRole('button', { name: 'Download sets' }));
    expect(fetchSnapshotLiftRecordParts).toHaveBeenCalledWith('snap-1');
    // The part list's own button, under the backup.
    const buttons = await screen.findAllByRole('button', { name: 'Download sets' });
    await user.click(buttons[buttons.length - 1] as HTMLElement);

    expect(downloadSnapshotLiftRecords).toHaveBeenCalledWith('snap-1', 1, 'fedcba9876543210');
    expect(saved).toEqual([expect.stringMatching(/^backup-lift-records-\d{4}-\d{2}-\d{2}\.csv$/)]);
  });

  it('asks before deleting a backup, says it can’t be undone, and deletes nothing if declined', async () => {
    const user = userEvent.setup();
    (fetchSnapshots as jest.Mock).mockResolvedValue([snapshot]);
    confirm.mockReturnValue(false);
    render(<TrainingData />);

    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('can’t be undone'));
    expect(deleteSnapshot).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    (deleteSnapshot as jest.Mock).mockResolvedValue(undefined);
    (fetchSnapshots as jest.Mock).mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(deleteSnapshot).toHaveBeenCalledWith('snap-1');
    expect(await screen.findByRole('status')).toHaveTextContent('Backup deleted.');
    await waitFor(() => expect(screen.getByText(/No backups/)).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Backups' })).toHaveFocus();
  });

  it('shows and reports a backup list that couldn’t be read', async () => {
    const failure = new Error('API down');
    (fetchSnapshots as jest.Mock).mockRejectedValue(failure);
    render(<TrainingData />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your backups');
    expect(logClientError).toHaveBeenCalledWith('fetchSnapshots', failure);
  });

  it('shows an import’s backup without Restore, and warns that deleting it ends that import’s undo (#1182)', async () => {
    const user = userEvent.setup();
    const replaced: DataSnapshotSummary = { ...snapshot, id: 'snap-2', kind: 'overwrite' };
    (fetchSnapshots as jest.Mock).mockResolvedValue([replaced]);
    confirm.mockReturnValue(false);
    render(<TrainingData />);

    const row = (await screen.findByText(/From an import that replaced stored history/)).closest('li');
    if (!row) throw new Error('expected the backup in a list item');
    expect(row).toHaveTextContent('Undo that import to put it back.');
    expect(within(row).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Download sets' })).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('can’t be undone after that'));
    expect(deleteSnapshot).not.toHaveBeenCalled();
  });
});
