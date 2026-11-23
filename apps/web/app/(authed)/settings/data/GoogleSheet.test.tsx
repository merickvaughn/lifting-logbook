import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const MIRRORED_AT = '2026-11-22T12:00:00.000Z';
const linked = view({
  status: 'linked',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
  lastMirroredAt: MIRRORED_AT,
});
const missing = view({ status: 'sheet_missing', spreadsheetUrl: 'https://old' });
const apiError = (status: number, error: string) =>
  new ApiClientError('nope', status, undefined, { error });
const PERMISSIONS = 'https://myaccount.google.com/permissions';
const linkButton = () => screen.queryByRole('button', { name: 'Link a Google Sheet' });
const heading = () => screen.getByRole('heading', { name: 'Google Sheet' });
/** A promise a test settles itself, to hold a call pending. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** Presses a button the way a keyboard user would: focused first. */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

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

  it('says so when the link can’t be read, and offers no button that would start a link', async () => {
    const err = apiError(500, 'boom');
    read.mockRejectedValue(err);
    render(<GoogleSheet />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load your Google Sheet link'));
    expect(logClientError).toHaveBeenCalledWith('fetchGoogleSheetLink', err);
    expect(linkButton()).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a callback notice at once but offers no button until the link has loaded', async () => {
    const pending = deferred<GoogleSheetLinkView>();
    read.mockReturnValue(pending.promise);
    render(<GoogleSheet notice="linked" />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Your Google Sheet is linked.'));
    expect(linkButton()).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    await act(async () => pending.resolve(linked));
    expect(await screen.findByRole('button', { name: 'Unlink' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your Google Sheet is linked.');
  });

  it('shows the result the callback route sent back', async () => {
    read.mockResolvedValue(view());
    render(<GoogleSheet notice="denied" />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Google access wasn’t granted'));
    expect(await screen.findByRole('button', { name: 'Link a Google Sheet' })).toBeInTheDocument();
  });

  it('tells the lifter to sign in again after the callback found no session', async () => {
    read.mockResolvedValue(view());
    render(<GoogleSheet notice="signin" />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sign in again'));
  });

  it('keeps its live regions mounted before anything is announced', async () => {
    read.mockResolvedValue(linked);
    render(<GoogleSheet />);
    await screen.findByRole('button', { name: 'Unlink' });
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status).toBeEmptyDOMElement();
    expect(alert).toBeEmptyDOMElement();

    unlink.mockResolvedValue({ revoked: true });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(status).toHaveTextContent('Unlinked.'));
    // The same elements, so the screen reader sees text added to them rather than new ones.
    expect(screen.getByRole('status')).toBe(status);
    expect(screen.getByRole('alert')).toBe(alert);
  });

  it('takes the notice out of the address', async () => {
    window.history.pushState(null, '', '/settings/data?google_sheet=linked&x=1');
    const replace = jest.spyOn(window.history, 'replaceState');
    read.mockResolvedValue(view());
    render(<GoogleSheet notice="linked" />);
    await screen.findByRole('button', { name: 'Link a Google Sheet' });

    expect(replace).toHaveBeenCalledWith(null, '', '/settings/data?x=1');
    expect(window.location.search).toBe('?x=1');
    replace.mockRestore();
  });

  it('leaves an address without the notice alone', async () => {
    window.history.pushState(null, '', '/settings/data?x=1');
    const replace = jest.spyOn(window.history, 'replaceState');
    read.mockResolvedValue(view());
    render(<GoogleSheet />);
    await screen.findByRole('button', { name: 'Link a Google Sheet' });
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  describe('linked', () => {
    it('shows the sheet link and when it last synced, never an account', async () => {
      // Even if the API sent one, it isn't shown.
      read.mockResolvedValue({ ...linked, email: 'lifter@example.com' });
      render(<GoogleSheet />);

      const open = await screen.findByRole('link', { name: 'Open your sheet' });
      expect(open).toHaveAttribute('href', linked.spreadsheetUrl);
      const expected = new Date(MIRRORED_AT).toLocaleString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      });
      expect(screen.getByText(`Last synced ${expected}.`)).toBeInTheDocument();
      expect(expected).toMatch(/2026/);
      expect(expected).toMatch(/\d:\d\d/);
      expect(document.body).not.toHaveTextContent('lifter@example.com');
      expect(document.body).not.toHaveTextContent('example.com');
    });

    it('says a sheet that was never mirrored is not synced yet', async () => {
      read.mockResolvedValue({ ...linked, lastMirroredAt: null });
      render(<GoogleSheet />);
      expect(await screen.findByText('Not synced yet.')).toBeInTheDocument();
    });

    it('unlinks, announces it, and moves focus to the heading', async () => {
      read.mockResolvedValue(linked);
      unlink.mockResolvedValue({ revoked: true });
      render(<GoogleSheet />);

      press(await screen.findByRole('button', { name: 'Unlink' }));

      expect(await screen.findByRole('button', { name: 'Link a Google Sheet' })).toBeInTheDocument();
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent('Unlinked.');
      expect(heading()).toHaveFocus();
      expect(screen.queryByRole('link', { name: PERMISSIONS })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Open your sheet' })).not.toBeInTheDocument();
    });

    it('leaves focus where the lifter moved it while the unlink ran', async () => {
      read.mockResolvedValue(linked);
      const pending = deferred<{ revoked: boolean }>();
      unlink.mockReturnValue(pending.promise);
      render(
        <>
          <input aria-label="elsewhere" />
          <GoogleSheet />
        </>,
      );
      press(await screen.findByRole('button', { name: 'Unlink' }));
      screen.getByLabelText('elsewhere').focus();

      await act(async () => pending.resolve({ revoked: true }));

      expect(screen.getByLabelText('elsewhere')).toHaveFocus();
    });

    it('links to Google’s permissions page when the revoke failed, and drops that on the next action', async () => {
      read.mockResolvedValue(linked);
      unlink.mockResolvedValue({ revoked: false, permissionsUrl: PERMISSIONS });
      authorize.mockResolvedValue({ url: 'https://accounts.google.com/x' });
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      const perms = await screen.findByRole('link', { name: PERMISSIONS });
      expect(perms).toHaveAttribute('href', PERMISSIONS);
      expect(screen.getByRole('status')).toHaveTextContent('Google didn’t confirm removing access');

      fireEvent.click(screen.getByRole('button', { name: 'Link a Google Sheet' }));
      await waitFor(() => expect(go).toHaveBeenCalled());
      expect(screen.queryByRole('link', { name: PERMISSIONS })).not.toBeInTheDocument();
    });

    it('logs a failed unlink, says so in fixed words, and keeps the link', async () => {
      read.mockResolvedValue(linked);
      const err = new Error('socket hang up at 10.0.0.1');
      unlink.mockRejectedValue(err);
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t unlink your sheet. Please try again.'));
      expect(screen.getByRole('alert')).not.toHaveTextContent('socket hang up');
      expect(logClientError).toHaveBeenCalledWith('unlinkGoogleSheet', err);
      expect(screen.getByRole('link', { name: 'Open your sheet' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Unlink' })).not.toHaveAttribute('aria-disabled');
    });

    it('says to check the link when the browser stopped waiting', async () => {
      read.mockResolvedValue(linked);
      unlink.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No answer came back in time'));
    });

    it('describes the mirror only while a sheet is linked', async () => {
      read.mockResolvedValue(linked);
      render(<GoogleSheet />);
      expect(await screen.findByText(/Your supplements are mirrored to a sheet/)).toBeInTheDocument();
    });
  });

  describe('linking', () => {
    it('logs a failed link, says so in fixed words, and stays usable', async () => {
      read.mockResolvedValue(view());
      const err = new Error('network down');
      authorize.mockRejectedValue(err);
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Link a Google Sheet' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t start linking. Please try again.'));
      expect(screen.getByRole('alert')).not.toHaveTextContent('network down');
      expect(logClientError).toHaveBeenCalledWith('authorizeGoogleSheet', err);
      expect(go).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Link a Google Sheet' })).not.toHaveAttribute('aria-disabled');
    });

    it('stays busy once it has sent the browser to Google, so a second press can’t start another flow', async () => {
      read.mockResolvedValue(view());
      authorize.mockResolvedValue({ url: 'https://accounts.google.com/x' });
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Link a Google Sheet' }));
      await waitFor(() => expect(go).toHaveBeenCalledTimes(1));

      const button = screen.getByRole('button', { name: 'Opening Google…' });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button);
      expect(authorize).toHaveBeenCalledTimes(1);
    });

    it('is usable again if the page comes back from Google out of the back/forward cache', async () => {
      read.mockResolvedValue(view());
      authorize.mockResolvedValue({ url: 'https://accounts.google.com/x' });
      render(<GoogleSheet />);
      fireEvent.click(await screen.findByRole('button', { name: 'Link a Google Sheet' }));
      await screen.findByRole('button', { name: 'Opening Google…' });

      act(() => {
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      });

      const button = screen.getByRole('button', { name: 'Link a Google Sheet' });
      expect(button).not.toHaveAttribute('aria-disabled');
      fireEvent.click(button);
      await waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    });
  });

  describe('needs_relink', () => {
    it('asks to link again, and also offers Unlink', async () => {
      read.mockResolvedValue(view({ status: 'needs_relink' }));
      authorize.mockResolvedValue({ url: 'https://accounts.google.com/x' });
      render(<GoogleSheet />);

      expect(await screen.findByText('Google access was removed. Link again.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Link a Google Sheet' }));
      await waitFor(() => expect(go).toHaveBeenCalled());
    });

    it('unlinks without linking again', async () => {
      read.mockResolvedValue(view({ status: 'needs_relink' }));
      unlink.mockResolvedValue({ revoked: true });
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      await waitFor(() => expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument());
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(go).not.toHaveBeenCalled();
      expect(screen.queryByText('Google access was removed. Link again.')).not.toBeInTheDocument();
      expect(linkButton()).toBeInTheDocument();
    });
  });

  describe('sheet_missing', () => {
    it('says the sheet is gone without also saying it is mirrored', async () => {
      read.mockResolvedValue(missing);
      render(<GoogleSheet />);
      expect(await screen.findByText('The sheet was deleted or can’t be found.')).toBeInTheDocument();
      expect(screen.queryByText(/Your supplements are mirrored/)).not.toBeInTheDocument();
    });

    it('creates a new sheet, announces it, and moves focus to the heading', async () => {
      read.mockResolvedValue(missing);
      create.mockResolvedValue(linked);
      render(<GoogleSheet />);

      press(await screen.findByRole('button', { name: 'Create a new sheet' }));

      expect(await screen.findByRole('link', { name: 'Open your sheet' })).toHaveAttribute('href', linked.spreadsheetUrl);
      expect(screen.getByRole('status')).toHaveTextContent('New sheet created.');
      expect(heading()).toHaveFocus();
    });

    it('unlinks', async () => {
      read.mockResolvedValue(missing);
      unlink.mockResolvedValue({ revoked: true });
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

      expect(await screen.findByRole('button', { name: 'Link a Google Sheet' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create a new sheet' })).not.toBeInTheDocument();
    });

    it('moves to “link again” when creating a sheet finds access removed', async () => {
      read.mockResolvedValue(view({ status: 'sheet_missing' }));
      create.mockRejectedValue(apiError(409, 'google-sheet-needs-relink'));
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Create a new sheet' }));

      expect(await screen.findByRole('button', { name: 'Link a Google Sheet' })).toBeInTheDocument();
      expect(logClientError).toHaveBeenCalledWith('createGoogleSheetSpreadsheet', expect.any(ApiClientError));
    });

    it('says so in fixed words when creating a sheet fails for any other reason, and stays usable', async () => {
      read.mockResolvedValue(missing);
      create.mockRejectedValue(apiError(502, 'google-sheet-google-error'));
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Create a new sheet' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t create a new sheet. Please try again.'));
      expect(screen.getByRole('alert')).not.toHaveTextContent('nope');
      expect(screen.getByRole('button', { name: 'Create a new sheet' })).not.toHaveAttribute('aria-disabled');
      expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
      expect(linkButton()).not.toBeInTheDocument();
    });

    it('ignores Unlink while a new sheet is being created', async () => {
      read.mockResolvedValue(missing);
      const pending = deferred<GoogleSheetLinkView>();
      create.mockReturnValue(pending.promise);
      render(<GoogleSheet />);

      fireEvent.click(await screen.findByRole('button', { name: 'Create a new sheet' }));
      const other = screen.getByRole('button', { name: 'Unlink' });
      expect(other).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(other);
      expect(unlink).not.toHaveBeenCalled();

      await act(async () => pending.resolve(linked));
      expect(create).toHaveBeenCalledTimes(1);
      expect(unlink).not.toHaveBeenCalled();
    });

    it('ignores a second press of the same button in the same tick', async () => {
      read.mockResolvedValue(missing);
      const pending = deferred<GoogleSheetLinkView>();
      create.mockReturnValue(pending.promise);
      render(<GoogleSheet />);

      const button = await screen.findByRole('button', { name: 'Create a new sheet' });
      act(() => {
        button.click();
        button.click();
      });
      expect(create).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve(linked));
    });
  });
});
