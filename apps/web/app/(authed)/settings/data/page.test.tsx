import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DataSettingsPage from './page';
import { downloadDataExport } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

jest.mock('@/lib/client-api', () => ({ downloadDataExport: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const download = downloadDataExport as jest.Mock;

describe('Settings → Data', () => {
  const saved: { href: string; download: string }[] = [];
  let click: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    saved.length = 0;
    URL.createObjectURL = jest.fn(() => 'blob:export');
    URL.revokeObjectURL = jest.fn();
    click = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        saved.push({ href: this.href, download: this.download });
      });
  });

  afterEach(() => click.mockRestore());

  it('saves the archive under a dated name, then releases its URL', async () => {
    const archive = new Blob(['zip']);
    download.mockResolvedValue(archive);
    render(<DataSettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled();

    await screen.findByRole('button', { name: 'Download my data' });
    expect(URL.createObjectURL).toHaveBeenCalledWith(archive);
    expect(saved).toEqual([
      {
        href: 'blob:export',
        download: expect.stringMatching(/^lifting-logbook-export-\d{4}-\d{2}-\d{2}\.zip$/),
      },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export');
  });

  it('shows and reports a failed download, and lets the user try again', async () => {
    const failure = new Error('Server said no');
    download.mockRejectedValue(failure);
    render(<DataSettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Server said no');
    expect(logClientError).toHaveBeenCalledWith('downloadDataExport', failure);
    expect(saved).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download my data' })).toBeEnabled());
  });

  it('says what the archive holds and links to import', () => {
    render(<DataSettingsPage />);

    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute('href', '/import');
    for (const file of ['lift-records.csv', 'training-maxes.csv', 'strength-goals.csv', 'program-spec.csv', 'logbook.json']) {
      expect(screen.getByText(file)).toBeInTheDocument();
    }
    expect(screen.getByText('logbook.json').parentElement).toHaveTextContent('logbook.json is the complete record');
  });
});
