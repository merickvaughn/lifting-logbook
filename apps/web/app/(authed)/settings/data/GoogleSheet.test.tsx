import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiClientError } from '@lifting-logbook/api-client';
import type { GoogleSheetLinkView } from '@lifting-logbook/types';
import GoogleSheet, { navigation } from './GoogleSheet';
import {
  authorizeGoogleSheet,
  createGoogleSheetSpreadsheet,
  fetchGoogleSheetLink,
  unlinkGoogleSheet,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

jest.mock('@/lib/client-api', () => ({
  fetchGoogleSheetLink: jest.fn(),
  authorizeGoogleSheet: jest.fn(),
  createGoogleSheetSpreadsheet: jest.fn(),
  unlinkGoogleSheet: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const read = fetchGoogleSheetLink as jest.Mock;
const authorize = authorizeGoogleSheet as jest.Mock;
const create = createGoogleSheetSpreadsheet as jest.Mock;
const unlink = unlinkGoogleSheet as jest.Mock;

const view = (over: Partial<GoogleSheetLinkView> = {}): GoogleSheetLinkView => ({
  configured: true,
  status: 'unlinked',
  spreadsheetUrl: null,
  lastMirroredAt: null,
  ...over,
});
const linked = view({
  status: 'linked',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
  lastMirroredAt: '2026-11-22T15:30:00.000Z',
});
const apiError = (status: number, error: string) =>
  new ApiClientError('nope', status, undefined, { error });

describe('Settings → Data → Google Sheet', () => {
  let go: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    go = jest.spyOn(navigation, 'go').mockImplementation(() => {});
  });
  afterEach(() => go.mockRestore());

  it('sends the browser to the URL the API returns when linking', async () => {
    read.mockResolvedValue(view());
    authorize.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    render(<GoogleSheet />);

    fireEvent.click(await screen.findByRole('button', { name: 'Link a Google Sheet' }));

    await waitFor(() => expect(go).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
  });

  it('isn’t shown when the API has no Google client', async () => {
    read.mockResolvedValue(view({ configured: false }));
    const { container } = render(<GoogleSheet />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('isn’t shown when the API answers 503 google-sheet-unconfigured', async () => {
    read.mockRejectedValue(apiError(503, 'google-sheet-unconfigured'));
    const { container } = render(<GoogleSheet />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(logClientError).not.toHaveBeenCalled();
  });

  it('says so when the link can’t be read', async () => {
    const err = apiError(500, 'boom');
    read.mockRejectedValue(err);
    render(<GoogleSheet />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your Google Sheet link');
    expect(logClientError).toHaveBeenCalledWith('fetchGoogleSheetLink', err);
  });

  it('shows the sheet link and last sync, never an account, and unlinks', async () => {
    read.mockResolvedValue(linked);
    unlink.mockResolvedValue({ revoked: true });
    render(<GoogleSheet />);

    const open = await screen.findByRole('link', { name: 'Open your sheet' });
    expect(open).toHaveAttribute('href', linked.spreadsheetUrl);
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(await screen.findByRole('button', { name: 'Link a Google Sheet' })).toBeInTheDocument();
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/permissions/)).not.toBeInTheDocument();
  });

  it('says a sheet that was never mirrored is not synced yet', async () => {
    read.mockResolvedValue({ ...linked, lastMirroredAt: null });
    render(<GoogleSheet />);
    expect(await screen.findByText('Not synced yet.')).toBeInTheDocument();
  });

  it('links to Google’s permissions page when the revoke failed', async () => {
    read.mockResolvedValue(linked);
    unlink.mockResolvedValue({ revoked: false, permissionsUrl: 'https://myaccount.google.com/permissions' });
    render(<GoogleSheet />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

    const perms = await screen.findByRole('link', { name: 'https://myaccount.google.com/permissions' });
    expect(perms).toHaveAttribute('href', 'https://myaccount.google.com/permissions');
    expect(screen.getByRole('button', { name: 'Link a Google Sheet' })).toBeInTheDocument();
  });

  it('asks to link again after Google access was removed', async () => {
    read.mockResolvedValue(view({ status: 'needs_relink' }));
    authorize.mockResolvedValue({ url: 'https://accounts.google.com/x' });
    render(<GoogleSheet />);

    expect(await screen.findByText('Google access was removed. Link again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Link a Google Sheet' }));
    await waitFor(() => expect(go).toHaveBeenCalled());
  });

  it('offers Create a new sheet when the sheet is gone', async () => {
    read.mockResolvedValue(view({ status: 'sheet_missing', spreadsheetUrl: 'https://old' }));
    create.mockResolvedValue(linked);
    render(<GoogleSheet />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create a new sheet' }));

    expect(await screen.findByRole('link', { name: 'Open your sheet' })).toHaveAttribute('href', linked.spreadsheetUrl);
  });

  it('moves to “link again” when creating a sheet finds access removed', async () => {
    read.mockResolvedValue(view({ status: 'sheet_missing' }));
    create.mockRejectedValue(apiError(409, 'google-sheet-needs-relink'));
    render(<GoogleSheet />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create a new sheet' }));

    expect(await screen.findByRole('button', { name: 'Link a Google Sheet' })).toBeInTheDocument();
    expect(logClientError).toHaveBeenCalledWith('createGoogleSheetSpreadsheet', expect.any(ApiClientError));
  });

  it('logs a failed link and stays usable', async () => {
    read.mockResolvedValue(view());
    const err = new Error('network down');
    authorize.mockRejectedValue(err);
    render(<GoogleSheet />);

    fireEvent.click(await screen.findByRole('button', { name: 'Link a Google Sheet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(logClientError).toHaveBeenCalledWith('authorizeGoogleSheet', err);
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Link a Google Sheet' })).not.toHaveAttribute('aria-disabled');
  });

  it('logs a failed unlink and keeps the link', async () => {
    read.mockResolvedValue(linked);
    const err = new Error('unlink failed');
    unlink.mockRejectedValue(err);
    render(<GoogleSheet />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('unlink failed');
    expect(logClientError).toHaveBeenCalledWith('unlinkGoogleSheet', err);
    expect(screen.getByRole('link', { name: 'Open your sheet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink' })).not.toHaveAttribute('aria-disabled');
  });

  it('shows the result the callback route sent back', async () => {
    read.mockResolvedValue(view());
    render(<GoogleSheet notice="denied" />);
    expect(await screen.findByRole('status')).toHaveTextContent('Google access wasn’t granted');
  });
});
