'use client';

import { useState } from 'react';
import type { LiftRecordExportPartsResponse } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import { logClientError } from '@/lib/log-client-error';
import { failureMessage, saveFile } from './saveFile';

/** The name the API gives a part, so a saved part matches one downloaded any other way (#1308). */
export function partFileName(prefix: string, part: number, parts: number): string {
  return `${prefix}lift-records-${localToday()}${parts > 1 ? `-part-${part}-of-${parts}` : ''}.csv`;
}

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
  const { parts } = listing;

  async function handleDownload(part: number) {
    setError(null);
    setDownloading(part);
    try {
      saveFile(await download(part), partFileName(fileNamePrefix, part, parts.length));
    } catch (err) {
      logClientError(op, err, { ...context, part: String(part) });
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
            <button type="button" onClick={() => handleDownload(p.part)} disabled={downloading !== null}>
              {downloading === p.part
                ? 'Downloading…'
                : parts.length > 1
                  ? `Download part ${p.part} of ${parts.length}`
                  : 'Download sets'}
            </button>{' '}
            {p.from} to {p.to}, {p.rows.toLocaleString()} {p.rows === 1 ? 'set' : 'sets'}
          </li>
        ))}
      </ol>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
