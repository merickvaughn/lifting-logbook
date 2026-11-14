'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatWeight, liftIdFor, storedIdListing } from '@lifting-logbook/core';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import type {
  ImportBatchSummary,
  ImportUndoResponse,
  MacrocycleOrigin,
  MacrocycleSummaryResponse,
  TrainingMaxHistoryEntryResponse,
  WeightUnit,
} from '@lifting-logbook/types';
import { undoImport } from '@/lib/client-api';
import { localToday } from '@/lib/calendarDay';
import { logClientError } from '@/lib/log-client-error';
import { STATUS_LABEL } from '@/lib/macrocycleStatus';
import type { EnrichedRecord } from './page';
import styles from './history.module.css';

type Tab = 'history' | 'timeline' | 'macrocycles';

export default function HistoryTabs({
  records,
  tmEntries,
  macrocycles,
  imports = [],
  unit,
}: {
  records: EnrichedRecord[];
  tmEntries: TrainingMaxHistoryEntryResponse[];
  macrocycles: MacrocycleSummaryResponse[];
  /** The imports that touched these macrocycles, newest first, each undoable (#1257). */
  imports?: ImportBatchSummary[];
  unit: WeightUnit;
}) {
  const [tab, setTab] = useState<Tab>('history');

  return (
    <div>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          className={`${styles.tab} ${tab === 'history' ? styles.tabActive : ''}`}
          onClick={() => setTab('history')}
          aria-selected={tab === 'history'}
        >
          Lift History
        </button>
        <button
          type="button"
          role="tab"
          className={`${styles.tab} ${tab === 'timeline' ? styles.tabActive : ''}`}
          onClick={() => setTab('timeline')}
          aria-selected={tab === 'timeline'}
        >
          TM Timeline
        </button>
        <button
          type="button"
          role="tab"
          className={`${styles.tab} ${tab === 'macrocycles' ? styles.tabActive : ''}`}
          onClick={() => setTab('macrocycles')}
          aria-selected={tab === 'macrocycles'}
        >
          Macrocycles
        </button>
      </div>

      <div role="tabpanel">
        {tab === 'history' && <LiftHistoryTab records={records} unit={unit} />}
        {tab === 'timeline' && <TmTimelineTab entries={tmEntries} unit={unit} />}
        {tab === 'macrocycles' && <MacrocyclesTab macrocycles={macrocycles} imports={imports} />}
      </div>
    </div>
  );
}

const ORIGIN_LABEL: Record<MacrocycleOrigin, string> = {
  imported: 'Imported',
  live: 'Logged here',
  legacy: 'Earlier records',
  'non-cycle': 'Outside a macrocycle',
};

/** An undo's outcome, worded as the import wizard words it. */
function undoSummary(result: ImportUndoResponse): string {
  return (
    `Undo complete: ${result.restored} restored` +
    (result.skipped > 0 ? `, ${result.skipped} skipped` : '') +
    (result.flagged.length > 0 ? `, ${result.flagged.length} flagged (modified since import)` : '') +
    '.'
  );
}

/**
 * Every macrocycle of the program, newest first (ADR-042), each with an Undo for the newest import
 * that touched it (#1257). An import is undone as a whole, so it asks first, and one undo runs at a
 * time: an import shows its Undo on every macrocycle it touched.
 */
function MacrocyclesTab({
  macrocycles,
  imports,
}: {
  macrocycles: MacrocycleSummaryResponse[];
  imports: ImportBatchSummary[];
}) {
  const router = useRouter();
  /** The macrocycle whose Undo is asking to confirm. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ macrocycleId: string; message: string } | null>(null);
  /** The last undo's outcome, kept across the refresh that removes its rows. */
  const [result, setResult] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ kind: 'confirm' | 'trigger'; id: string } | 'result' | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const confirmButton = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);

  // Focus follows the control that replaced the one focused: the confirm button when it opens, the
  // Undo button again on Cancel, and the outcome once the undone rows are gone.
  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget === 'result') resultRef.current?.focus();
    else if (focusTarget.kind === 'confirm') confirmButton.current?.focus();
    else triggers.current.get(focusTarget.id)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const importOf = useMemo(() => {
    const byMacrocycle = new Map<string, ImportBatchSummary>();
    for (const batch of imports) {
      for (const id of batch.macrocycleIds) if (!byMacrocycle.has(id)) byMacrocycle.set(id, batch);
    }
    return byMacrocycle;
  }, [imports]);

  async function handleUndo(batch: ImportBatchSummary, macrocycleId: string) {
    setBusy(true);
    setError(null);
    try {
      const undone = await undoImport(batch.program, batch.id, localToday());
      setConfirming(null);
      setResult(undoSummary(undone));
      setFocusTarget('result');
      router.refresh();
    } catch (e) {
      logClientError('undoImport', e, { programId: batch.program, batchId: batch.id });
      setError({ macrocycleId, message: e instanceof Error ? e.message : 'Undo failed' });
    } finally {
      setBusy(false);
    }
  }

  // Both branches render the outcome as the first child of a `div`, so undoing the last import
  // keeps the same element, with its focus and announcement, when the table gives way.
  if (macrocycles.length === 0) {
    return (
      <div>
        <UndoResult result={result} resultRef={resultRef} />
        <p className={styles.empty}>No macrocycles yet.</p>
      </div>
    );
  }
  return (
    <div>
      <UndoResult result={result} resultRef={resultRef} />
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Macrocycle</th>
              <th>Start</th>
              <th>End</th>
              <th>Status</th>
              <th>Source</th>
              <th>
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {macrocycles
              .slice()
              .reverse()
              .map((m) => {
                const batch = importOf.get(m.id);
                const question = `undo-question-${m.id}`;
                return (
                  <tr key={m.id}>
                    <td>
                      {m.macrocycleNum}
                      {m.current && ' (current)'}
                    </td>
                    <td>{m.startDate}</td>
                    <td>{m.endDate ?? '—'}</td>
                    <td>{STATUS_LABEL[m.status]}</td>
                    <td>{ORIGIN_LABEL[m.origin]}</td>
                    <td>
                      {batch && (
                        <div className={styles.undoImport}>
                          {confirming === m.id ? (
                            <>
                              <span id={question}>
                                Undo this import? Every set it added goes, from every program and macrocycle it
                                wrote to.
                              </span>
                              <button
                                ref={confirmButton}
                                type="button"
                                className={styles.undoButton}
                                aria-describedby={question}
                                onClick={() => handleUndo(batch, m.id)}
                                disabled={busy}
                              >
                                {busy ? 'Undoing…' : 'Undo import'}
                              </button>
                              <button
                                type="button"
                                className={styles.undoButton}
                                onClick={() => {
                                  setConfirming(null);
                                  setFocusTarget({ kind: 'trigger', id: m.id });
                                }}
                                disabled={busy}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              ref={(el) => {
                                if (el) triggers.current.set(m.id, el);
                                else triggers.current.delete(m.id);
                              }}
                              type="button"
                              className={styles.undoButton}
                              aria-label={`Undo import of macrocycle ${m.macrocycleNum}`}
                              onClick={() => {
                                setConfirming(m.id);
                                setError(null);
                                setResult(null);
                                setFocusTarget({ kind: 'confirm', id: m.id });
                              }}
                              disabled={busy}
                            >
                              Undo import
                            </button>
                          )}
                          {error?.macrocycleId === m.id && (
                            <p role="alert" className={styles.undoError}>
                              {error.message}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The last undo's outcome, in a live region that's always mounted so the outcome is announced. */
function UndoResult({
  result,
  resultRef,
}: {
  result: string | null;
  resultRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <div role="status">
      {result && (
        <p ref={resultRef} tabIndex={-1} className={styles.undoResult}>
          {result}
        </p>
      )}
    </div>
  );
}

function LiftHistoryTab({ records, unit }: { records: EnrichedRecord[]; unit: WeightUnit }) {
  const [search, setSearch] = useState('');
  const [liftFilter, setLiftFilter] = useState('');

  const listing = useMemo(() => storedIdListing(records.map((r) => r.lift)), [records]);
  const lifts = useMemo(
    () => Array.from(new Set(records.map((r) => listing(r.lift)))).sort(),
    [records, listing],
  );

  const visible = useMemo(() => {
    const q = search.toLowerCase();
    return records.filter((r) => {
      if (liftFilter && listing(r.lift) !== liftFilter) return false;
      if (q) {
        const matchesLift = [r.lift, listing(r.lift), liftIdFor(r.lift)].some((name) =>
          name.toLowerCase().includes(q),
        );
        const matchesDate = r.date.includes(q);
        const matchesNotes = r.notes.toLowerCase().includes(q);
        if (!matchesLift && !matchesDate && !matchesNotes) return false;
      }
      return true;
    });
  }, [records, search, liftFilter, listing]);

  return (
    <div>
      <div className={styles.filters}>
        <input
          type="text"
          placeholder="Search lift, date, or notes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={styles.searchInput}
          aria-label="Search records"
        />
        <select
          value={liftFilter}
          onChange={(e) => setLiftFilter(e.target.value)}
          className={styles.select}
          aria-label="Filter by lift"
        >
          <option value="">All Lifts</option>
          {lifts.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <p className={styles.empty}>No records match the current filters.</p>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Lift</th>
                <th>Weight × Reps</th>
                <th>TM</th>
                <th>% of TM</th>
                <th>Context</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td>{r.date}</td>
                  <td>{r.lift}</td>
                  <td>
                    {formatWeight(r.weight, 'lbs', unit)} × {r.reps}
                  </td>
                  <td>
                    {r.tmAtTime !== null
                      ? formatWeight(r.tmAtTime, r.tmUnit ?? 'lbs', unit)
                      : '—'}
                  </td>
                  <td>{r.tmPercent !== null ? `${r.tmPercent}%` : '—'}</td>
                  <td>
                    {r.program === NON_CYCLE_PROGRAM ? (
                      <Link href={`/non-cycle/${r.workoutNum}`}>Non-cycle workout {r.workoutNum}</Link>
                    ) : (
                      <>
                        Macrocycle {r.macrocycleNum}, Workout {r.workoutNum}
                      </>
                    )}
                  </td>
                  <td>{r.notes || '—'}</td>
                  <td>
                    {r.isPR && <span className={styles.prBadge}>PR</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TmTimelineTab({
  entries,
  unit,
}: {
  entries: TrainingMaxHistoryEntryResponse[];
  unit: WeightUnit;
}) {
  const [liftFilter, setLiftFilter] = useState('');

  const listing = useMemo(() => storedIdListing(entries.map((e) => e.lift)), [entries]);
  const lifts = useMemo(
    () => Array.from(new Set(entries.map((e) => listing(e.lift)))).sort(),
    [entries, listing],
  );

  const byLift = useMemo(() => {
    const filtered = liftFilter
      ? entries.filter((e) => listing(e.lift) === liftFilter)
      : entries;
    const groups = new Map<string, TrainingMaxHistoryEntryResponse[]>();
    for (const e of filtered) {
      const lift = listing(e.lift);
      const group = groups.get(lift) ?? [];
      group.push(e);
      groups.set(lift, group);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([lift, es]) => ({
        lift,
        entries: es.slice().sort((a, b) => b.date.localeCompare(a.date)),
      }));
  }, [entries, liftFilter, listing]);

  return (
    <div>
      <div className={styles.filters}>
        <select
          value={liftFilter}
          onChange={(e) => setLiftFilter(e.target.value)}
          className={styles.select}
          aria-label="Filter by lift"
        >
          <option value="">All Lifts</option>
          {lifts.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>

      {byLift.length === 0 ? (
        <p className={styles.empty}>No TM history recorded yet.</p>
      ) : (
        byLift.map(({ lift, entries: liftEntries }) => (
          <section key={lift} className={styles.liftGroup}>
            <h2 className={styles.liftGroupHeading}>{lift}</h2>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Weight</th>
                    <th>Source</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {liftEntries.map((e) => (
                    <tr key={e.id}>
                      <td>{e.date}</td>
                      <td>
                        {formatWeight(e.weight, e.unit, unit)}
                      </td>
                      <td>
                        {e.source === 'test' ? 'Test Week' : 'Program'}
                      </td>
                      <td>
                        {e.isPR && (
                          <span className={styles.prBadge}>PR</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
