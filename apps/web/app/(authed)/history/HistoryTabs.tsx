'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatWeight, liftIdFor, storedIdListing } from '@lifting-logbook/core';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import type {
  ImportBatchSummary,
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

/**
 * Every macrocycle of the program, newest first (ADR-042), each with an Undo for the newest import
 * that touched it (#1257).
 */
function MacrocyclesTab({
  macrocycles,
  imports,
}: {
  macrocycles: MacrocycleSummaryResponse[];
  imports: ImportBatchSummary[];
}) {
  const importOf = useMemo(() => {
    const byMacrocycle = new Map<string, ImportBatchSummary>();
    for (const batch of imports) {
      for (const id of batch.macrocycleIds) if (!byMacrocycle.has(id)) byMacrocycle.set(id, batch);
    }
    return byMacrocycle;
  }, [imports]);
  if (macrocycles.length === 0) {
    return <p className={styles.empty}>No macrocycles yet.</p>;
  }
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Macrocycle</th>
            <th>Start</th>
            <th>End</th>
            <th>Status</th>
            <th>Source</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {macrocycles
            .slice()
            .reverse()
            .map((m) => {
              const batch = importOf.get(m.id);
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
                  <td>{batch && <UndoImport batch={batch} macrocycleNum={m.macrocycleNum} />}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Undoes an import from the past-macrocycles list, once the wizard is gone (#1257). The import is
 * undone as a whole, so it asks first: every set it added goes, from every macrocycle and program.
 */
function UndoImport({ batch, macrocycleNum }: { batch: ImportBatchSummary; macrocycleNum: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUndo() {
    setBusy(true);
    setError(null);
    try {
      await undoImport(batch.program, batch.id, localToday());
      setConfirming(false);
      router.refresh();
    } catch (e) {
      logClientError('undoImport', e, { programId: batch.program, batchId: batch.id });
      setError(e instanceof Error ? e.message : 'Undo failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.undoImport}>
      {confirming ? (
        <>
          <span>Undo this import? Every set it added goes, from every program and macrocycle it wrote to.</span>
          <button type="button" className={styles.undoButton} onClick={handleUndo} disabled={busy}>
            {busy ? 'Undoing…' : 'Undo import'}
          </button>
          <button type="button" className={styles.undoButton} onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className={styles.undoButton}
          aria-label={`Undo the import of macrocycle ${macrocycleNum}`}
          onClick={() => setConfirming(true)}
        >
          Undo import
        </button>
      )}
      {error && (
        <p role="alert" className={styles.undoError}>
          {error}
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
