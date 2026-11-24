'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GoogleSheetLinkView } from '@lifting-logbook/types';
import {
  authorizeGoogleSheet,
  createGoogleSheetSpreadsheet,
  fetchGoogleSheetLink,
  syncGoogleSheet,
  unlinkGoogleSheet,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import BusyButton from './BusyButton';
import { GOOGLE_SHEET_NOTICES, GOOGLE_SHEET_NOTICE_PARAM, googleSheetErrorName, type GoogleSheetNoticeCode } from './googleSheetNotice';

const PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

const TIMED_OUT = 'No answer came back in time. Check the link below, then try again.';

/**
 * API errors that say what state the link is really in (Sync now's 409s, #1444): the section
 * switches to that state's view and says so in fixed words.
 */
const LINK_STATE_ERRORS: Record<string, { status: GoogleSheetLinkView['status']; copy: string }> = {
  'google-sheet-not-linked': { status: 'unlinked', copy: 'No sheet is linked.' },
  'google-sheet-needs-relink': { status: 'needs_relink', copy: 'Google access was removed. Link again.' },
  'google-sheet-missing': { status: 'sheet_missing', copy: 'The sheet was deleted or can’t be found.' },
};

/** Sends the browser to Google; a seam so tests can watch it, since jsdom can't navigate. */
export const navigation = { go: (url: string) => window.location.assign(url) };

/** When the mirror last ran, as the lifter's own date and time with its time zone. */
export function formatLastSynced(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * Link a Google Sheet and Unlink (#1433, ADR-047 decisions 9-12). The section isn't shown when the
 * API has no Google client. Nothing here shows the lifter's Google account.
 */
export default function GoogleSheet({ notice }: { notice?: GoogleSheetNoticeCode }) {
  const [link, setLink] = useState<GoogleSheetLinkView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeFailed, setRevokeFailed] = useState(false);
  // Read synchronously, so a second press in the same tick can't start a second action.
  const running = useRef(false);
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // The notice is set after the live region has mounted, so a screen reader announces it.
  useEffect(() => {
    if (notice) setMessage(GOOGLE_SHEET_NOTICES[notice]);
  }, [notice]);

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

  // Coming back to this page from Google (the browser's Back button) restores it as it was left,
  // still busy opening Google.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      running.current = false;
      setBusy(null);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // The button that started a change can leave the page with it, taking keyboard focus along, so
  // focus moves to the heading unless the lifter has moved it somewhere else meanwhile.
  const settleFocus = () => {
    const active = document.activeElement;
    if (active === null || active === document.body || section.current?.contains(active)) {
      heading.current?.focus();
    }
  };

  /** Runs one action. `fn` returns true when the page is leaving, so the buttons stay busy. */
  const run = useCallback(
    async (action: string, fn: () => Promise<boolean | void>, fallback: string) => {
      if (running.current) return;
      running.current = true;
      setError(null);
      setMessage(null);
      setRevokeFailed(false);
      setBusy(action);
      let leaving = false;
      try {
        leaving = (await fn()) === true;
      } catch (err) {
        logClientError(action, err);
        const name = googleSheetErrorName(err);
        const state = name !== undefined && Object.hasOwn(LINK_STATE_ERRORS, name) ? LINK_STATE_ERRORS[name] : undefined;
        setError(state ? state.copy : err instanceof Error && err.name === 'TimeoutError' ? TIMED_OUT : fallback);
        if (state) {
          setLink((l) =>
            l
              ? state.status === 'unlinked'
                ? { ...l, status: 'unlinked', spreadsheetUrl: null, lastMirroredAt: null }
                : { ...l, status: state.status }
              : l,
          );
        }
      } finally {
        if (!leaving) {
          running.current = false;
          setBusy(null);
        }
      }
    },
    [],
  );

  const startLink = () =>
    run(
      'authorizeGoogleSheet',
      async () => {
        const { url } = await authorizeGoogleSheet();
        navigation.go(url);
        return true;
      },
      'Couldn’t start linking. Please try again.',
    );

  const createSheet = () =>
    run(
      'createGoogleSheetSpreadsheet',
      async () => {
        setLink(await createGoogleSheetSpreadsheet());
        setMessage('New sheet created.');
        settleFocus();
      },
      'Couldn’t create a new sheet. Please try again.',
    );

  const syncNow = () =>
    run(
      'syncGoogleSheet',
      async () => {
        await syncGoogleSheet();
        setMessage('Sync started. Your sheet updates in a minute or so.');
        settleFocus();
      },
      'Couldn’t start a sync. Please try again.',
    );

  const unlink = () =>
    run(
      'unlinkGoogleSheet',
      async () => {
        const result = await unlinkGoogleSheet();
        setRevokeFailed(!result.revoked);
        setLink((l) => (l ? { ...l, status: 'unlinked', spreadsheetUrl: null, lastMirroredAt: null } : l));
        setMessage('Unlinked.');
        settleFocus();
      },
      'Couldn’t unlink your sheet. Please try again.',
    );

  if (hidden) return null;
  // Until the link is read there's nothing to offer, but a notice or a failed read still says so.
  if (!link && !error && !notice) return null;

  const status = link?.status;
  const anyBusy = busy !== null;
  const linkButton = (
    <BusyButton onClick={startLink} busy={anyBusy}>
      {busy === 'authorizeGoogleSheet' ? 'Opening Google…' : 'Link a Google Sheet'}
    </BusyButton>
  );
  const syncButton = (
    <BusyButton onClick={syncNow} busy={anyBusy}>
      {busy === 'syncGoogleSheet' ? 'Starting sync…' : 'Sync now'}
    </BusyButton>
  );
  const unlinkButton = (
    <BusyButton onClick={unlink} busy={anyBusy}>
      {busy === 'unlinkGoogleSheet' ? 'Unlinking…' : 'Unlink'}
    </BusyButton>
  );

  return (
    <section ref={section}>
      <h2 ref={heading} tabIndex={-1}>
        Google Sheet
      </h2>
      {link && (
        <>
          {status === 'linked' ? (
            <p>Your supplements are mirrored to a sheet in your Google Drive.</p>
          ) : (
            <p>Mirror your supplements to a Google Sheet in your own Drive. This app can only open files it creates.</p>
          )}
          {status === 'linked' && (
            <>
              <p>
                <a href={link.spreadsheetUrl ?? undefined} target="_blank" rel="noreferrer">
                  Open your sheet
                </a>
              </p>
              <p>{link.lastMirroredAt ? `Last synced ${formatLastSynced(link.lastMirroredAt)}.` : 'Not synced yet.'}</p>
              {link.syncFailed && <p>Last sync failed.</p>}
              {syncButton} {unlinkButton}
            </>
          )}
          {status === 'sheet_missing' && (
            <>
              <p>The sheet was deleted or can’t be found.</p>
              <BusyButton onClick={createSheet} busy={anyBusy}>
                {busy === 'createGoogleSheetSpreadsheet' ? 'Creating…' : 'Create a new sheet'}
              </BusyButton>{' '}
              {unlinkButton}
            </>
          )}
          {status === 'needs_relink' && (
            <>
              <p>Google access was removed. Link again.</p>
              {linkButton} {unlinkButton}
            </>
          )}
          {status !== 'linked' && status !== 'sheet_missing' && status !== 'needs_relink' && linkButton}
        </>
      )}
      {/* Both live regions stay mounted, so a screen reader announces what's put into them. */}
      <div role="status">
        {message && <p>{message}</p>}
        {revokeFailed && status === 'unlinked' && (
          <p>
            Your sheet is unlinked, but Google didn’t confirm removing access. You can remove it at{' '}
            <a href={PERMISSIONS_URL} target="_blank" rel="noreferrer">
              {PERMISSIONS_URL}
            </a>
            .
          </p>
        )}
      </div>
      <div role="alert">{error && <p>{error}</p>}</div>
    </section>
  );
}
