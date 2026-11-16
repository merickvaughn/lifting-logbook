'use client';

import { useEffect, useRef, useState } from 'react';
import { liftRecordExportFileName } from '@lifting-logbook/core';
import type { LiftRecordExportPartsResponse } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import { logClientError } from '@/lib/log-client-error';
import BusyButton from './BusyButton';
import { failureMessage, saveFile } from './saveFile';

/**
 * One download per part of a sets download, oldest first (decision 22). `op` names the download
 * in a failure log, and `context` says which one.
 */
export default function PartsList({
  listing,
  download,
  fileNamePrefix = '',
  op,
  context,
}: {
  listing: LiftRecordExportPartsResponse;
  download: (part: number) => Promise<Blob>;
  fileNamePrefix?: string;
  op: string;
  context?: Record<string, string>;
}) {
  const [downloading, setDownloading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A new listing, such as the one a 409 asks for, starts without the old one's error.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [shown, setShown] = useState(listing);
  if (shown !== listing) {
    setShown(listing);
    setError(null);
  }
  const latest = useRef(listing);
  useEffect(() => {
    latest.current = listing;
  }, [listing]);
  const { parts } = listing;

  async function handleDownload(part: number) {
    const started = listing;
    setError(null);
    setDownloading(part);
    try {
      saveFile(await download(part), fileNamePrefix + liftRecordExportFileName(localToday(), part, parts.length));
    } catch (err) {
      logClientError(op, err, { ...context, part: String(part) });
      // Listed again while this downloaded: the error is about the old listing.
      if (latest.current !== started) return;
      setError(
        failureMessage(
          err,
          'This download took too long, so nothing was saved. Please try again in a moment.',
          'Couldn’t download these sets. Please try again.',
        ),
      );
    } finally {
      setDownloading(null);
    }
  }

  if (parts.length === 0) return <p>No sets to download.</p>;
  return (
    <div>
      <p>
        {listing.rows.toLocaleString()} {listing.rows === 1 ? 'set' : 'sets'}
        {parts.length > 1 && ` in ${parts.length} parts`}.
      </p>
      {parts.length > 1 && (
        <p>
          They&apos;re split between macrocycles so each part fits the importer. Upload them on the
          Import page in this order, oldest first.
        </p>
      )}
      <ol>
        {parts.map((p) => (
          <li key={p.part}>
            <BusyButton onClick={() => handleDownload(p.part)} busy={downloading !== null}>
              {downloading === p.part
                ? 'Downloading…'
                : parts.length > 1
                  ? `Download part ${p.part} of ${parts.length}`
                  : 'Download sets'}
            </BusyButton>{' '}
            {p.from} to {p.to}, {p.rows.toLocaleString()} {p.rows === 1 ? 'set' : 'sets'}
          </li>
        ))}
      </ol>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
