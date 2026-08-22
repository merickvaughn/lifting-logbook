'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
import type { ImportError, SkippedRecord } from '@lifting-logbook/types';
import { importLiftRecords } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

interface Props {
  program: string;
}

type Status = 'idle' | 'loading' | 'success' | 'error';

interface SuccessState {
  written: number;
  skipped: SkippedRecord[];
}

export default function LiftRecordsImportForm({ program }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [successData, setSuccessData] = useState<SuccessState | null>(null);
  const [errors, setErrors] = useState<ImportError[]>([]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setStatus('loading');
    setErrors([]);
    setSuccessData(null);

    try {
      const result = await importLiftRecords(program, file);
      if (result.ok) {
        setStatus('success');
        setSuccessData({ written: result.data.written, skipped: result.data.skipped });
      } else {
        setStatus('error');
        setErrors(result.errors);
      }
    } catch (err) {
      // importLiftRecords resolves to { ok: false } for row-validation failures, but a
      // network/CORS/5xx error still throws — previously that left the form stuck on
      // "Uploading…" with nothing logged. Surface a generic error and record the cause (#783).
      logClientError('importLiftRecords', err, { program });
      setStatus('error');
      setErrors([{ row: 0, message: 'Upload failed. Please try again.' }]);
    }
  }

  return (
    <section style={{ marginTop: '2rem' }}>
      <h3>Import Historical Lift Records</h3>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        Upload a CSV file exported from Google Sheets. All rows are validated before
        any data is written — if any row fails, the entire upload is rejected.
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          disabled={status === 'loading'}
          aria-label="CSV file"
          required
        />
        <button type="submit" disabled={status === 'loading'}>
          {status === 'loading' ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      {status === 'success' && successData && (
        <div style={{ marginTop: '1rem', color: 'green' }}>
          <strong>
            Imported {successData.written} record{successData.written !== 1 ? 's' : ''}.
            {successData.skipped.length > 0 &&
              ` Skipped ${successData.skipped.length} duplicate${successData.skipped.length !== 1 ? 's' : ''}.`}
          </strong>
          {successData.skipped.length > 0 && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary>Skipped rows</summary>
              <ul style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                {successData.skipped.map((s) => (
                  <li key={`${s.row}-${s.naturalKey}`}>
                    Row {s.row}: {s.naturalKey}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {status === 'error' && errors.length > 0 && (
        <div style={{ marginTop: '1rem', color: 'red' }}>
          <strong>Upload rejected — fix the following errors and try again:</strong>
          {errors.some((err) => err.field === IMPORT_ERROR_FIELD_LIFT) && (
            <p style={{ marginTop: '0.5rem' }}>
              This form can&apos;t map an unrecognized exercise name to an existing
              one or create it for you. <Link href="/import">Use the Smart Import
              Wizard</Link> instead — it lets you resolve unrecognized exercises
              interactively before anything is imported.
            </p>
          )}
          {/* Capped like ImportWizard.tsx's own commitErrors list — this
              form is all-or-nothing against up to MAX_IMPORT_ROWS rows, and
              a CSV whose exercise column isn't named "Lift" produces one
              error per row, so an uncapped list can run to thousands of
              <li> nodes in one render. Placed after (not before) the Wizard
              guidance above, so the most useful next step isn't pushed
              below the fold by the very list its own error most commonly
              triggers. */}
          <ul style={{ fontFamily: 'monospace', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            {errors.slice(0, 20).map((err, i) => (
              <li key={i}>
                Row {err.row}
                {err.field ? ` (${err.field})` : ''}: {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
