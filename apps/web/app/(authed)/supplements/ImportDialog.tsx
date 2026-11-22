'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SupplementSheetTab } from '@lifting-logbook/types';
import { applyImportReview, defaultDecisions, mapSupplementSheet } from '@lifting-logbook/core';
import type { ImportDecision, SupplementImportCandidate } from '@lifting-logbook/core';
import { localToday } from '@/lib/calendarDay';
import { fetchSupplementSheet, importSupplements } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { BulkDialog } from './BulkDialogs';
import styles from './supplements.module.css';

type Step = { kind: 'link' } | { kind: 'tab'; tabs: SupplementSheetTab[] } | { kind: 'review'; tab: string; rows: SupplementImportCandidate[] };

const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

/**
 * Import from Google Sheets (#1379), in the lift import's steps: paste a link, pick the tab, review
 * each row (active, pending or skip; a repeated name can be merged into its first row), import.
 */
export default function ImportDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'link' });
  const [url, setUrl] = useState('');
  const [decisions, setDecisions] = useState<ImportDecision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (op: string, fallback: string, action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      logClientError(op, err);
      setError(message(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const load = () =>
    run('supplements.importFetch', 'Couldn’t read that sheet. Check the link and that it is shared.', async () => {
      const { tabs } = await fetchSupplementSheet(url.trim());
      if (tabs.length === 0) throw new Error('That sheet has no tabs with rows.');
      setStep({ kind: 'tab', tabs });
    });

  const pick = (tab: SupplementSheetTab) => {
    const rows = mapSupplementSheet(tab);
    if (rows.length === 0) {
      setError(`“${tab.name}” has no Compound column with rows. Pick another tab.`);
      return;
    }
    setError(undefined);
    setDecisions(defaultDecisions(rows));
    setStep({ kind: 'review', tab: tab.name, rows });
  };

  const commit = (tab: string, rows: SupplementImportCandidate[]) =>
    run('supplements.import', 'Couldn’t import. Nothing was saved.', async () => {
      await importSupplements({ source: tab, rows: applyImportReview(rows, decisions) }, localToday());
      router.refresh();
      onClose();
    });

  const importing = step.kind === 'review' ? applyImportReview(step.rows, decisions).length : 0;

  return (
    <BulkDialog id="import-title" title="Import from Google Sheets" subtitle="Bring in a supplement sheet shared by link." busy={busy} onCancel={onClose}>
      {step.kind === 'link' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label>
            Google Sheets link
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
          </label>
          <button type="submit" disabled={busy || url.trim() === ''}>
            {busy ? 'Reading…' : 'Read sheet'}
          </button>
        </form>
      )}
      {step.kind === 'tab' && (
        <ul className={styles.list}>
          {step.tabs.map((t) => (
            <li key={t.name}>
              <button type="button" onClick={() => pick(t)}>
                {t.name}
              </button>{' '}
              <span className={styles.line2}>{t.rows.length - 1} rows</span>
            </li>
          ))}
        </ul>
      )}
      {step.kind === 'review' && (
        <>
          <ul className={styles.list}>
            {step.rows.map((r, i) => (
              <li key={r.index}>
                <strong>{r.name}</strong> <span className={styles.line2}>{[r.doses[0]?.amount, r.timing].filter(Boolean).join(' · ')}</span>
                {r.duplicateOf !== undefined && (
                  <p role="note" className={styles.line2}>
                    Same name as {step.rows[r.duplicateOf]?.name} (row {r.duplicateOf + 1}). Merge it into that row, or keep both.
                  </p>
                )}
                <select
                  aria-label={`${r.name} (row ${i + 1})`}
                  value={decisions[i]}
                  onChange={(e) => setDecisions((d) => d.map((x, j) => (j === i ? (e.target.value as ImportDecision) : x)))}
                >
                  <option value="active">Active</option>
                  <option value="pending">Pending</option>
                  <option value="skip">Skip</option>
                  {r.duplicateOf !== undefined && <option value="merge">Merge into row {r.duplicateOf + 1}</option>}
                </select>
              </li>
            ))}
          </ul>
          <button type="button" disabled={busy || importing === 0} onClick={() => void commit(step.tab, step.rows)}>
            {busy ? 'Importing…' : `Import ${importing} ${importing === 1 ? 'item' : 'items'}`}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </BulkDialog>
  );
}
