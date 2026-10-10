'use client';

import { useState, useMemo } from 'react';
import { formatWeight } from '@lifting-logbook/core';
import type { TrainingMaxHistoryEntryResponse, WeightUnit } from '@lifting-logbook/types';
import { toggleHistoryPR, toggleHistoryGoalMet } from './actions';

type View = 'timeline' | 'list';
type Filter = 'pr' | 'test' | 'goalMet';

export default function MaxHistory({
  initialEntries,
  program,
  unit,
}: {
  initialEntries: TrainingMaxHistoryEntryResponse[];
  program: string;
  unit: WeightUnit;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [view, setView] = useState<View>('list');
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [liftFilter, setLiftFilter] = useState<string>('');
  const [pending, setPending] = useState<Set<string>>(new Set());

  const lifts = useMemo(
    () => Array.from(new Set(entries.map((e) => e.lift))).sort(),
    [entries],
  );

  const visible = useMemo(() => {
    let list = [...entries];
    if (liftFilter) list = list.filter((e) => e.lift === liftFilter);
    if (filters.has('pr')) list = list.filter((e) => e.isPR);
    if (filters.has('test')) list = list.filter((e) => e.source === 'test');
    if (filters.has('goalMet')) list = list.filter((e) => e.goalMet);
    return list;
  }, [entries, filters, liftFilter]);

  function toggleFilter(f: Filter) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  async function handleTogglePR(entry: TrainingMaxHistoryEntryResponse) {
    setPending((p) => new Set(p).add(entry.id));
    try {
      const updated = await toggleHistoryPR(program, entry.id, !entry.isPR);
      setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(entry.id);
        return next;
      });
    }
  }

  async function handleToggleGoalMet(entry: TrainingMaxHistoryEntryResponse) {
    setPending((p) => new Set(p).add(entry.id));
    try {
      const updated = await toggleHistoryGoalMet(program, entry.id, !entry.goalMet);
      setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(entry.id);
        return next;
      });
    }
  }

  if (entries.length === 0) {
    return (
      <section style={{ marginTop: '2rem' }}>
        <h2>Training Max History</h2>
        <p style={{ color: 'var(--color-text-muted, #888)' }}>
          No history yet. History entries are recorded each time a new macrocycle starts or maxes are recalculated.
        </p>
      </section>
    );
  }

  return (
    <section style={{ marginTop: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Training Max History</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
            style={{ fontWeight: view === 'list' ? 'bold' : 'normal' }}
          >
            List
          </button>
          <button
            onClick={() => setView('timeline')}
            aria-pressed={view === 'timeline'}
            style={{ fontWeight: view === 'timeline' ? 'bold' : 'normal' }}
          >
            Timeline
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <button
          onClick={() => setFilters(new Set())}
          aria-pressed={filters.size === 0}
          style={{ fontWeight: filters.size === 0 ? 'bold' : 'normal' }}
        >
          All
        </button>
        {(['pr', 'test', 'goalMet'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => toggleFilter(f)}
            aria-pressed={filters.has(f)}
            style={{ fontWeight: filters.has(f) ? 'bold' : 'normal' }}
          >
            {f === 'pr' ? 'PRs' : f === 'test' ? 'Test Week' : 'Goal Met'}
          </button>
        ))}
        <select
          value={liftFilter}
          onChange={(e) => setLiftFilter(e.target.value)}
          aria-label="Filter by lift"
        >
          <option value="">All Lifts</option>
          {lifts.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted, #888)' }}>No entries match the selected filters.</p>
      ) : view === 'list' ? (
        <ListView
          entries={visible}
          pending={pending}
          onTogglePR={handleTogglePR}
          onToggleGoalMet={handleToggleGoalMet}
          unit={unit}
        />
      ) : (
        <TimelineView
          entries={visible}
          pending={pending}
          onTogglePR={handleTogglePR}
          onToggleGoalMet={handleToggleGoalMet}
          unit={unit}
        />
      )}
    </section>
  );
}

type EntryHandlers = {
  pending: Set<string>;
  onTogglePR: (e: TrainingMaxHistoryEntryResponse) => void;
  onToggleGoalMet: (e: TrainingMaxHistoryEntryResponse) => void;
  unit: WeightUnit;
};

function ListView({
  entries,
  ...handlers
}: { entries: TrainingMaxHistoryEntryResponse[] } & EntryHandlers) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Date</th>
          <th style={{ textAlign: 'left' }}>Lift</th>
          <th style={{ textAlign: 'right' }}>Weight</th>
          <th style={{ textAlign: 'center' }}>Source</th>
          <th style={{ textAlign: 'center' }}>PR</th>
          <th style={{ textAlign: 'center' }}>Goal Met</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <EntryRow key={e.id} entry={e} {...handlers} />
        ))}
      </tbody>
    </table>
  );
}

function TimelineView({
  entries,
  ...handlers
}: { entries: TrainingMaxHistoryEntryResponse[] } & EntryHandlers) {
  const byMonth = useMemo(() => {
    const groups = new Map<string, TrainingMaxHistoryEntryResponse[]>();
    for (const e of entries) {
      const key = e.date.slice(0, 7); // YYYY-MM
      const group = groups.get(key) ?? [];
      group.push(e);
      groups.set(key, group);
    }
    return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries]);

  return (
    <div>
      {byMonth.map(([month, monthEntries]) => (
        <div key={month} style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.5rem' }}>{month}</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {monthEntries.map((e) => (
                <EntryRow key={e.id} entry={e} {...handlers} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function EntryRow({
  entry,
  pending,
  onTogglePR,
  onToggleGoalMet,
  unit,
}: { entry: TrainingMaxHistoryEntryResponse } & EntryHandlers) {
  const busy = pending.has(entry.id);
  return (
    <tr>
      <td>{entry.date}</td>
      <td>{entry.lift}</td>
      <td style={{ textAlign: 'right' }}>{formatWeight(entry.weight, entry.unit, unit)}</td>
      <td style={{ textAlign: 'center' }}>
        <span title={entry.source === 'test' ? 'Test week' : 'New macrocycle'}>
          {entry.source === 'test' ? 'Test' : 'Program'}
        </span>
      </td>
      <td style={{ textAlign: 'center' }}>
        <button
          disabled={busy}
          onClick={() => onTogglePR(entry)}
          aria-label={`${entry.isPR ? 'Remove PR flag from' : 'Mark as PR for'} ${entry.lift} on ${entry.date}`}
          title={entry.isPR ? 'Remove PR flag' : 'Mark as PR'}
        >
          {entry.isPR ? '🏆 PR' : '—'}
        </button>
      </td>
      <td style={{ textAlign: 'center' }}>
        <button
          disabled={busy}
          onClick={() => onToggleGoalMet(entry)}
          aria-label={`${entry.goalMet ? 'Unmark goal met for' : 'Mark goal met for'} ${entry.lift} on ${entry.date}`}
          title={entry.goalMet ? 'Unmark goal met' : 'Mark goal met'}
        >
          {entry.goalMet ? '✓ Goal' : '—'}
        </button>
      </td>
    </tr>
  );
}
