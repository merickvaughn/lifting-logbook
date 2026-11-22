'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiClientError } from '@lifting-logbook/api-client';
import type { SupplementSheetTab } from '@lifting-logbook/types';
import { applyImportReview, defaultDecisions, mapSupplementSheet } from '@lifting-logbook/core';
import type { ImportDecision, SupplementImportCandidate } from '@lifting-logbook/core';
import { localToday } from '@/lib/calendarDay';
import { fetchSupplementSheet, importSupplements } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { BulkDialog } from './BulkDialogs';
import importStyles from '../import/import.module.css';
import styles from './supplements.module.css';

type Step = { kind: 'link' } | { kind: 'tab'; tabs: SupplementSheetTab[] } | { kind: 'review'; tabs: SupplementSheetTab[]; tab: string; rows: SupplementImportCandidate[] };

/** The fixed sentence, plus the API's own message when it refused the request (a 4xx), which says why. */
const failure = (err: unknown, fixed: string) =>
  err instanceof ApiClientError && err.status >= 400 && err.status < 500 && err.message ? `${fixed} ${err.message}` : fixed;

const rowCount = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

const DECISIONS: readonly ImportDecision[] = ['active', 'pending', 'skip', 'merge'];

interface Props {
  /** The stack's items, so a row already in it is flagged and starts as skipped. */
  items: readonly { name: string; catalogKey?: string }[];
  /** ×, or Esc: nothing was imported. */
  onCancel: () => void;
  /** The import saved `count` items. */
  onDone: (count: number) => void;
}

/**
 * Import from Google Sheets (#1379), in the lift import's steps: paste a link, pick the tab, review
 * each row (active, pending or skip; a repeat can be merged into its first row), import. Each step's
 * heading takes focus when the step changes, and Back keeps what was entered.
 */
export default function ImportDialog({ items, onCancel, onDone }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'link' });
  // Counts step changes, so the new step's heading takes focus after it renders (not on open).
  const [moves, setMoves] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const [url, setUrl] = useState('');
  const [decisions, setDecisions] = useState<ImportDecision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (moves > 0) heading.current?.focus();
  }, [moves]);

  const go = (next: Step) => {
    setError(undefined);
    setStep(next);
    setMoves((n) => n + 1);
  };

  const run = async (op: string, fixed: string, ctx: Record<string, unknown>, action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      logClientError(op, err, ctx);
      setError(failure(err, fixed));
    } finally {
      setBusy(false);
    }
  };

  const load = () => {
    if (busy) return;
    return run('supplements.importFetch', 'Couldn’t read that sheet. Check the link and that it’s shared.', {}, async () => {
      const { tabs } = await fetchSupplementSheet(url.trim());
      go({ kind: 'tab', tabs });
    });
  };

  const pick = (tabs: SupplementSheetTab[], tab: SupplementSheetTab) => {
    const rows = mapSupplementSheet(tab, items);
    if (rows.length === 0) {
      setError(`“${tab.name}” has no Compound column with rows. Pick another tab.`);
      return;
    }
    setDecisions(defaultDecisions(rows));
    go({ kind: 'review', tabs, tab: tab.name, rows });
  };

  /** Sets row `i`'s decision; a row merging into a row now skipped goes back to Active. */
  const decide = (rows: SupplementImportCandidate[], i: number, d: ImportDecision) =>
    setDecisions((prev) =>
      prev.map((x, j) => (j === i ? d : d === 'skip' && x === 'merge' && rows[j]?.duplicateOf === i ? 'active' : x)),
    );

  const commit = (tab: string, rows: SupplementImportCandidate[]) => {
    if (busy) return;
    const reviewed = applyImportReview(rows, decisions);
    return run('supplements.import', 'Couldn’t import. Nothing was saved.', { rows: rows.length, imported: reviewed.length }, async () => {
      const skipped = decisions.filter((d) => d === 'skip').length;
      await importSupplements({ source: tab, rows: reviewed, skipped }, localToday());
      router.refresh();
      onDone(reviewed.length);
    });
  };

  const importing = step.kind === 'review' ? applyImportReview(step.rows, decisions).length : 0;

  return (
    <BulkDialog id="import-title" title="Import from Google Sheets" subtitle="Bring in a supplement sheet shared by link." busy={busy} onCancel={onCancel}>
      {step.kind === 'link' && (
        <>
          <h3 ref={heading} tabIndex={-1} className={importStyles.stepTitle}>
            Paste a link
          </h3>
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            <label>
              Google Sheets link
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
            </label>
            <div className={styles.formButtons}>
              <button type="submit" disabled={busy || url.trim() === ''}>
                {busy ? 'Reading…' : 'Read sheet'}
              </button>
            </div>
          </form>
        </>
      )}
      {step.kind === 'tab' && (
        <>
          <h3 ref={heading} tabIndex={-1} className={importStyles.stepTitle}>
            Pick a tab
          </h3>
          {step.tabs.length === 0 ? (
            <p className={importStyles.infoBox}>That sheet has no tabs with rows.</p>
          ) : (
            <ul className={styles.list}>
              {step.tabs.map((t) => (
                <li key={t.name} className={styles.importRow}>
                  {t.skipReason === null ? (
                    <span>
                      <button type="button" onClick={() => pick(step.tabs, t)}>
                        {t.name}
                      </button>{' '}
                      <span className={styles.line2}>{rowCount(mapSupplementSheet(t).length)}</span>
                    </span>
                  ) : (
                    <span>
                      {t.name} <span className={styles.line2}>Not importable: {t.skipReason}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className={styles.formButtons}>
            <button type="button" onClick={() => go({ kind: 'link' })}>
              Back
            </button>
          </div>
        </>
      )}
      {step.kind === 'review' && (
        <>
          <h3 ref={heading} tabIndex={-1} className={importStyles.stepTitle}>
            Review rows
          </h3>
          <p className={importStyles.stepHint}>
            From “{step.tab}”. Mark each row Active, Pending or Skip.
          </p>
          <ul className={styles.list}>
            {step.rows.map((r, i) => {
              const target = r.duplicateOf === undefined ? undefined : step.rows[r.duplicateOf];
              const targetSkipped = r.duplicateOf !== undefined && decisions[r.duplicateOf] === 'skip';
              const id = `import-row-${i}`;
              const described = [`${id}-line`, r.inStack ? `${id}-stack` : '', target ? `${id}-dup` : ''].filter(Boolean).join(' ');
              return (
                <li key={r.index} className={styles.importRow}>
                  <span>
                    <span className={styles.line2}>Row {r.sheetRow}</span> <strong>{r.name}</strong>
                  </span>
                  <span id={`${id}-line`} className={styles.line2}>
                    {[r.amount, r.timing].filter(Boolean).join(' · ') || 'No amount or timing'}
                  </span>
                  {r.inStack && (
                    <p id={`${id}-stack`} className={styles.line2}>
                      Already in your stack.
                    </p>
                  )}
                  {target && (
                    <p id={`${id}-dup`} className={styles.line2}>
                      Same supplement as {target.name} (row {target.sheetRow}).{' '}
                      {targetSkipped
                        ? `Row ${target.sheetRow} is skipped, so this row can’t be merged into it.`
                        : 'Merge it into that row, or keep both.'}
                    </p>
                  )}
                  <select
                    aria-label={`${r.name} (row ${r.sheetRow})`}
                    aria-describedby={described}
                    value={decisions[i]}
                    onChange={(e) => decide(step.rows, i, DECISIONS.find((d) => d === e.target.value) ?? 'active')}
                  >
                    <option value="active">Active</option>
                    <option value="pending">Pending</option>
                    <option value="skip">Skip</option>
                    {target && (
                      <option value="merge" disabled={targetSkipped}>
                        Merge into row {target.sheetRow}
                      </option>
                    )}
                  </select>
                </li>
              );
            })}
          </ul>
          <div className={styles.formButtons}>
            <button type="button" disabled={busy || importing === 0} onClick={() => void commit(step.tab, step.rows)}>
              {busy ? 'Importing…' : `Import ${importing} ${importing === 1 ? 'item' : 'items'}`}
            </button>
            <button type="button" disabled={busy} onClick={() => go({ kind: 'tab', tabs: step.tabs })}>
              Back
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </BulkDialog>
  );
}
