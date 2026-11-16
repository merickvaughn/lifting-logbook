'use client';

import { useEffect, useState } from 'react';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import type { LiftRecordExportPartsResponse, LiftRecordExportQuery, MacrocycleSummaryResponse } from '@lifting-logbook/types';
import { downloadLiftRecordExport, fetchLiftRecordExportParts, fetchMacrocycles } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import type { UserProgram } from '@/lib/user-programs';
import PartsList from './PartsList';
import { failureMessage } from './saveFile';

function macrocycleLabel(m: MacrocycleSummaryResponse): string {
  return `Macrocycle ${m.macrocycleNum}, from ${m.startDate}${m.endDate ? ` to ${m.endDate}` : ''}`;
}

/** A CSV of sets the importer reads back, filtered by program, macrocycle or dates (#1308). */
export default function SetsExport({ programs }: { programs: UserProgram[] }) {
  const [program, setProgram] = useState('');
  const [macrocycle, setMacrocycle] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [macrocycles, setMacrocycles] = useState<MacrocycleSummaryResponse[]>([]);
  const [listing, setListing] = useState<{ filter: LiftRecordExportQuery; parts: LiftRecordExportPartsResponse } | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasMacrocycles = program !== '' && program !== NON_CYCLE_PROGRAM;

  useEffect(() => {
    setMacrocycles([]);
    if (!hasMacrocycles) return;
    let current = true;
    fetchMacrocycles(program).then(
      (list) => current && setMacrocycles(list),
      (err: unknown) => {
        if (!current) return;
        logClientError('fetchMacrocycles', err, { program });
        setError('Couldn’t load this program’s macrocycles. You can still download all of its sets.');
      },
    );
    return () => {
      current = false;
    };
  }, [program, hasMacrocycles]);

  // A listing describes the filter it was made for.
  function change(set: (value: string) => void) {
    return (value: string) => {
      set(value);
      setListing(null);
      setError(null);
    };
  }

  async function handleFind() {
    const filter: LiftRecordExportQuery = {
      ...(program && { program }),
      ...(hasMacrocycles && macrocycle && { macrocycle }),
      ...(from && { from }),
      ...(to && { to }),
    };
    setError(null);
    setFinding(true);
    try {
      setListing({ filter, parts: await fetchLiftRecordExportParts(filter) });
    } catch (err) {
      logClientError('fetchLiftRecordExportParts', err);
      setError(
        failureMessage(
          err,
          'Finding your sets took too long. Please try again in a moment.',
          'Couldn’t find your sets. Please try again.',
        ),
      );
    } finally {
      setFinding(false);
    }
  }

  return (
    <section aria-labelledby="sets-export-heading">
      <h2 id="sets-export-heading">Download sets</h2>
      <p>
        A CSV of the sets you choose, which you can upload again on the Import page. Training
        maxes and setup aren&apos;t included.
      </p>
      <div>
        <label>
          Program{' '}
          <select
            value={program}
            onChange={(e) => {
              change(setProgram)(e.target.value);
              setMacrocycle('');
            }}
          >
            <option value="">All programs</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NON_CYCLE_PROGRAM}>Non-cycle workouts</option>
          </select>
        </label>
      </div>
      {hasMacrocycles && (
        <div>
          <label>
            Macrocycle{' '}
            <select value={macrocycle} onChange={(e) => change(setMacrocycle)(e.target.value)}>
              <option value="">All macrocycles</option>
              {macrocycles.map((m) => (
                <option key={m.id} value={m.id}>
                  {macrocycleLabel(m)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div>
        <label>
          From <input type="date" value={from} max={to || undefined} onChange={(e) => change(setFrom)(e.target.value)} />
        </label>{' '}
        <label>
          To <input type="date" value={to} min={from || undefined} onChange={(e) => change(setTo)(e.target.value)} />
        </label>
      </div>
      <button type="button" onClick={handleFind} disabled={finding}>
        {finding ? 'Finding sets…' : 'Find sets'}
      </button>
      {error && <p role="alert">{error}</p>}
      {listing && (
        <PartsList
          listing={listing.parts}
          download={(part) => downloadLiftRecordExport({ ...listing.filter, part, split: listing.parts.split })}
          op="downloadLiftRecordExport"
        />
      )}
    </section>
  );
}
