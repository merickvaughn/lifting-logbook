'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GoogleSheetLinkView } from '@lifting-logbook/types';
import {
  authorizeGoogleSheet,
  createGoogleSheetSpreadsheet,
  fetchGoogleSheetLink,
  unlinkGoogleSheet,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import BusyButton from './BusyButton';
import { GOOGLE_SHEET_NOTICES, GOOGLE_SHEET_NOTICE_PARAM, googleSheetErrorName, type GoogleSheetNoticeCode } from './googleSheetNotice';
import { failureMessage } from './saveFile';

const PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

/** Sends the browser to Google; a seam so tests can watch it, since jsdom can't navigate. */
export const navigation = { go: (url: string) => window.location.assign(url) };

/**
 * Link a Google Sheet and Unlink (#1433, ADR-047 decisions 9-12). The section isn't shown when the
 * API has no Google client. Nothing here shows the lifter's Google account.
 */
export default function GoogleSheet({ notice }: { notice?: GoogleSheetNoticeCode }) {
  const [link, setLink] = useState<GoogleSheetLinkView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(notice ? GOOGLE_SHEET_NOTICES[notice] : null);
  const [error, setError] = useState<string | null>(null);
  const [revokeFailed, setRevokeFailed] = useState(false);

  useEffect(() => {
    // The notice is a one-time result: take it out of the address so a reload doesn't repeat it.
    const url = new URL(window.location.href);
    if (url.searchParams.has(GOOGLE_SHEET_NOTICE_PARAM)) {
      url.searchParams.delete(GOOGLE_SHEET_NOTICE_PARAM);
      window.history.replaceState(null, '', url.pathname + url.search);
    }
  }, []);

  useEffect(() => {
    fetchGoogleSheetLink().then(
      (view) => (view.configured ? setLink(view) : setHidden(true)),
      (err) => {
        if (googleSheetErrorName(err) === 'google-sheet-unconfigured') return setHidden(true);
        logClientError('fetchGoogleSheetLink', err);
        setError('Couldn’t load your Google Sheet link. Reload the page to try again.');
      },
    );
  }, []);

  const run = useCallback(async (action: string, fn: () => Promise<void>, fallback: string) => {
    setError(null);
    setMessage(null);
    setBusy(action);
    try {
      await fn();
    } catch (err) {
      logClientError(action, err);
      setError(
        googleSheetErrorName(err) === 'google-sheet-needs-relink'
          ? 'Google access was removed. Link again.'
          : failureMessage(err, 'No answer came back in time. Check the link below, then try again.', fallback),
      );
      if (googleSheetErrorName(err) === 'google-sheet-needs-relink') {
        setLink((l) => (l ? { ...l, status: 'needs_relink' } : l));
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const startLink = () =>
    run(
      'authorizeGoogleSheet',
      async () => {
        const { url } = await authorizeGoogleSheet();
        navigation.go(url);
      },
      'Couldn’t start linking. Please try again.',
    );

  const createSheet = () =>
    run('createGoogleSheetSpreadsheet', async () => setLink(await createGoogleSheetSpreadsheet()), 'Couldn’t create a new sheet. Please try again.');

  const unlink = () =>
    run(
      'unlinkGoogleSheet',
      async () => {
        const result = await unlinkGoogleSheet();
        setRevokeFailed(!result.revoked);
        setLink((l) => (l ? { ...l, status: 'unlinked', spreadsheetUrl: null, lastMirroredAt: null } : l));
      },
      'Couldn’t unlink your sheet. Please try again.',
    );

  if (hidden) return null;
  // Until the link is read there's nothing to offer, but a failed read still says so.
  if (!link && !error && !message) return null;

  const status = link?.status;
  const linkButton = (
    <BusyButton onClick={startLink} busy={busy === 'authorizeGoogleSheet'}>
      {busy === 'authorizeGoogleSheet' ? 'Opening Google…' : 'Link a Google Sheet'}
    </BusyButton>
  );
  const unlinkButton = (
    <BusyButton onClick={unlink} busy={busy === 'unlinkGoogleSheet'}>
      {busy === 'unlinkGoogleSheet' ? 'Unlinking…' : 'Unlink'}
    </BusyButton>
  );

  return (
    <section>
      <h2>Google Sheet</h2>
      {status === 'linked' || status === 'sheet_missing' ? (
        <p>
          Your supplements are mirrored to a sheet in your Google Drive.
        </p>
      ) : (
        <p>Mirror your supplements to a Google Sheet in your own Drive. This app can only open files it creates.</p>
      )}
      {status === 'linked' && link && (
        <>
          <p>
            <a href={link.spreadsheetUrl ?? undefined} target="_blank" rel="noreferrer">
              Open your sheet
            </a>
          </p>
          <p>
            {link.lastMirroredAt
              ? `Last synced ${new Date(link.lastMirroredAt).toLocaleString()}.`
              : 'Not synced yet.'}
          </p>
          {unlinkButton}
        </>
      )}
      {status === 'sheet_missing' && (
        <>
          <p>The sheet was deleted or can’t be found.</p>
          <BusyButton onClick={createSheet} busy={busy === 'createGoogleSheetSpreadsheet'}>
            {busy === 'createGoogleSheetSpreadsheet' ? 'Creating…' : 'Create a new sheet'}
          </BusyButton>{' '}
          {unlinkButton}
        </>
      )}
      {status === 'needs_relink' && (
        <>
          <p>Google access was removed. Link again.</p>
          {linkButton}
        </>
      )}
      {status !== 'linked' && status !== 'sheet_missing' && status !== 'needs_relink' && linkButton}
      {revokeFailed && status === 'unlinked' && (
        <p role="status">
          Your sheet is unlinked, but Google didn’t confirm removing access. You can remove it at{' '}
          <a href={PERMISSIONS_URL} target="_blank" rel="noreferrer">
            {PERMISSIONS_URL}
          </a>
          .
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
