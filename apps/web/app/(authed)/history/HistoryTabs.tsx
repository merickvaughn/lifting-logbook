'use client';

import { useState, useMemo } from 'react';
import { formatWeight } from '@lifting-logbook/core';
import type { TrainingMaxHistoryEntryResponse, WeightUnit } from '@lifting-logbook/types';
import type { EnrichedRecord } from './page';
import styles from './history.module.css';

type Tab = 'history' | 'timeline';

export default function HistoryTabs({
  records,
  tmEntries,
  unit,
}: {
  records: EnrichedRecord[];
  tmEntries: TrainingMaxHistoryEntryResponse[];
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
      </div>

      <div role="tabpanel">
        {tab === 'history' ? (
          <LiftHistoryTab records={records} unit={unit} />
        ) : (
          <TmTimelineTab entries={tmEntries} unit={unit} />
        )}
      </div>
    </div>
  );
}

function LiftHistoryTab({ records, unit }: { records: EnrichedRecord[]; unit: WeightUnit }) {
  const [search, setSearch] = useState('');
  const [liftFilter, setLiftFilter] = useState('');

  const lifts = useMemo(
    () => Array.from(new Set(records.map((r) => r.lift))).sort(),
    [records],
  );

  const visible = useMemo(() => {
    const q = search.toLowerCase();
    return records.filter((r) => {
      if (liftFilter && r.lift !== liftFilter) return false;
      if (q) {
        const matchesLift = r.lift.toLowerCase().includes(q);
        const matchesDate = r.date.includes(q);
        const matchesNotes = r.notes.toLowerCase().includes(q);
        if (!matchesLift && !matchesDate && !matchesNotes) return false;
      }
      return true;
    });
  }, [records, search, liftFilter]);

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
                    Macrocycle {r.macrocycleNum}, Workout {r.workoutNum}
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

  const lifts = useMemo(
    () => Array.from(new Set(entries.map((e) => e.lift))).sort(),
    [entries],
  );

  const byLift = useMemo(() => {
    const filtered = liftFilter
      ? entries.filter((e) => e.lift === liftFilter)
      : entries;
    const groups = new Map<string, TrainingMaxHistoryEntryResponse[]>();
    for (const e of filtered) {
      const group = groups.get(e.lift) ?? [];
      group.push(e);
      groups.set(e.lift, group);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([lift, es]) => ({
        lift,
        entries: es.slice().sort((a, b) => b.date.localeCompare(a.date)),
      }));
  }, [entries, liftFilter]);

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
