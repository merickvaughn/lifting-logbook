import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiftRecordExportPartsResponse } from '@lifting-logbook/types';
import PartsList from './PartsList';
import { logClientError } from '@/lib/log-client-error';

jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const listing = (split: string): LiftRecordExportPartsResponse => ({
  rows: 30,
  split,
  parts: [
    { part: 1, rows: 20, from: '2025-01-01', to: '2025-06-30' },
    { part: 2, rows: 10, from: '2025-07-01', to: '2025-12-31' },
  ],
});

describe('Settings → Data → a sets download’s parts', () => {
  it('keeps the part being downloaded focusable, and ignores the other parts meanwhile', async () => {
    const user = userEvent.setup();
    const download = jest.fn(() => new Promise<Blob>(() => {}));
    render(<PartsList listing={listing('a')} download={download} op="downloadLiftRecordExport" />);

    await user.click(screen.getByRole('button', { name: 'Download part 1 of 2' }));
    const busy = screen.getByRole('button', { name: 'Downloading…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Download part 2 of 2' }));

    expect(download).toHaveBeenCalledTimes(1);
  });

  it('doesn’t show an old listing’s download error beside a new listing', async () => {
    const user = userEvent.setup();
    let fail: (err: Error) => void = () => {};
    const download = jest.fn(() => new Promise<Blob>((_, reject) => (fail = reject)));
    const { rerender } = render(<PartsList listing={listing('a')} download={download} op="downloadLiftRecordExport" />);

    await user.click(screen.getByRole('button', { name: 'Download part 1 of 2' }));
    rerender(<PartsList listing={listing('b')} download={download} op="downloadLiftRecordExport" />);
    fail(new Error('These parts have changed. List the parts again.'));

    await waitFor(() => expect(logClientError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download part 1 of 2' })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
