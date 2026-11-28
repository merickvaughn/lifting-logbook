'use client';

import Link from 'next/link';
import { useState } from 'react';
import { downloadDataExport } from '@/lib/client-api';
import { localToday } from '@/lib/calendarDay';
import { logClientError } from '@/lib/log-client-error';
import BusyButton from './BusyButton';
import { failureMessage, saveFile } from './saveFile';

/** The whole logbook as one zip (#947). */
export default function DownloadAll() {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setError(null);
    setDownloading(true);
    try {
      const archive = await downloadDataExport();
      saveFile(archive, `lifting-logbook-export-${localToday()}.zip`);
    } catch (err) {
      logClientError('downloadDataExport', err);
      setError(
        failureMessage(
          err,
          'Your download took too long, so nothing was saved. Please try again in a moment.',
          'Failed to download your data.',
        ),
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section>
      <h2>Data</h2>
      <p>
        Downloads one zip file with everything in your logbook. The CSV files open in any
        spreadsheet, and you can upload them on the <Link href="/import">Import</Link> page.
      </p>
      <ul>
        <li>
          <code>lift-records.csv</code> has every set you logged, in every program. A long
          history is split into numbered parts, which you upload oldest first.
        </li>
        <li>
          <code>training-maxes.csv</code>, <code>strength-goals.csv</code> and{' '}
          <code>program-spec.csv</code> cover your active program. Any other program has its
          own folder under <code>other-programs</code>.
        </li>
        <li>
          <code>complexes.csv</code> has your barbell complexes. Upload it before a program that
          plans one, so the program finds them.
        </li>
        <li>
          <code>logbook.json</code>{' '}
          is the complete record. Importing doesn&apos;t read it, so it&apos;s the only copy of what the CSV files leave out, such as a custom
          program&apos;s name and description.
        </li>
      </ul>
      <div>
        <BusyButton onClick={handleDownload} busy={downloading}>
          {downloading ? 'Preparing…' : 'Download my data'}
        </BusyButton>
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
