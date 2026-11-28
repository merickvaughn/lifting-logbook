'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  parseCsvText,
  classifyImport,
  parseTrainingMaxes,
  type TrainingMax,
} from '@lifting-logbook/core';
import type { ImportClassification } from '@lifting-logbook/types';
import styles from '../onboarding.module.css';
import type { LiftRow } from '../lib';

// Mirrors the API import guards (apps/api/src/programs/import-file.util.ts:
// MAX_IMPORT_ROWS = 5_000; Fastify multipart caps the request body at 5 MB).
// Those constants are API-side only and the web app cannot import from apps/api,
// so the same limits are re-stated here for the client-side parse.
const MAX_IMPORT_ROWS = 5_000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// Friendly labels for the "this isn't a training-maxes file" redirect, keyed by
// the other ImportKind values classifyImport can return.
const KIND_LABEL: Record<string, string> = {
  'lift-records': 'lift history',
  'strength-goals': 'strength goals',
  'program-spec': 'a program definition',
  complexes: 'barbell complexes',
};

type Props = {
  /** Called with one row per lift (latest training max) once a file parses. */
  onImported: (rows: LiftRow[]) => void;
};

// Read a File as text via FileReader rather than `File.text()`: the latter is
// unimplemented in the jsdom version used by the component tests, whereas
// FileReader is supported in both jsdom and every target browser.
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// Accept a file as training maxes when it classifies as such outright, or when
// training-maxes is a close-call runner-up (the user clearly uploaded TMs and
// another kind only edged it out). Anything else routes to the full /import tool.
function looksLikeTrainingMaxes(c: ImportClassification): boolean {
  if (c.type === 'training-maxes') return true;
  return c.alternatives.some((a) => a.type === 'training-maxes' && a.closeCall);
}

// A training-maxes export can carry history — several dated rows per lift. For
// onboarding we want each lift's *current* training max, so keep the row with
// the most recent dateUpdated per lift and drop non-positive weights.
function latestPerLift(maxes: TrainingMax[]): LiftRow[] {
  const byLift = new Map<string, { weight: number; dateUpdated: Date }>();
  for (const m of maxes) {
    const lift = String(m.lift).trim();
    if (!lift || !(m.weight > 0)) continue;
    const prev = byLift.get(lift);
    if (!prev || m.dateUpdated.getTime() > prev.dateUpdated.getTime()) {
      byLift.set(lift, { weight: m.weight, dateUpdated: m.dateUpdated });
    }
  }
  return Array.from(byLift.entries()).map(([lift, { weight }]) => ({
    lift,
    weight: String(weight),
    reps: '',
  }));
}

export function StepImport({ onImported }: Props) {
  const inputId = useId();
  const [error, setError] = useState<ReactNode>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<LiftRow[] | null>(null);
  // Always-current ref so event handlers never capture a stale rows snapshot.
  const rowsRef = useRef<LiftRow[] | null>(null);
  rowsRef.current = rows;
  // Stable counter so each uploaded file resets keyed inputs (avoids stale values).
  const uploadGen = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function applyRows(next: LiftRow[]) {
    setRows(next);
    onImported(next);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    // Clear so re-selecting the same file still fires onChange.
    input.value = '';

    // On any failure we leave a prior successful import staged so the advance
    // gate stays open and the user can fix their export without losing progress.
    if (file.size > MAX_IMPORT_BYTES) {
      setError('That file is larger than 5 MB. Export a smaller training-maxes file and try again.');
      return;
    }

    let table;
    try {
      const text = await readFileText(file);
      table = parseCsvText(text);
    } catch {
      setError("We couldn't read that file. Make sure it's a CSV exported from a spreadsheet.");
      return;
    }

    if (table.length < 2) {
      setError('That file has no data rows. Expected a header row plus one row per lift.');
      return;
    }
    if (table.length - 1 > MAX_IMPORT_ROWS) {
      setError(`That file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Trim it and try again.`);
      return;
    }

    const classification = classifyImport(table);
    if (!looksLikeTrainingMaxes(classification)) {
      const label =
        (classification.type && KIND_LABEL[classification.type]) ??
        'something other than training maxes';
      // The link opens in a new tab so this onboarding tab keeps its progress
      // (#1391). /import needs a program, so the copy still says to finish setup.
      setError(
        <>
          This looks like {label}. Finish setup, then use the{' '}
          <Link
            href="/import"
            target="_blank"
            prefetch={false}
            rel="noopener noreferrer"
            className={styles.inlineLinkBtn}
          >
            full Import tool
          </Link>{' '}
          (opens in a new tab) to bring it in.
        </>,
      );
      return;
    }

    let maxes: TrainingMax[];
    try {
      maxes = parseTrainingMaxes(table);
    } catch {
      setError(
        "We found training-max columns but couldn't read every row. Check that each row has a date, a lift name, and a numeric weight.",
      );
      return;
    }

    const parsed = latestPerLift(maxes);
    if (parsed.length === 0) {
      setError('No training maxes were found in that file.');
      return;
    }

    uploadGen.current += 1;
    setFileName(file.name);
    applyRows(parsed);
  }

  function updateWeight(index: number, weight: string) {
    const current = rowsRef.current;
    if (!current) return;
    applyRows(current.map((r, i) => (i === index ? { ...r, weight } : r)));
  }

  function removeRow(index: number) {
    const current = rowsRef.current;
    if (!current) return;
    applyRows(current.filter((_, i) => i !== index));
  }

  const summaryId = `${inputId}-summary`;

  return (
    <>
      <h2 className={styles.stepTitle}>Import your training maxes</h2>
      <p className={styles.stepHint}>
        Upload a training-maxes CSV (exported from a spreadsheet or another app) and we&apos;ll
        fill these in for you &mdash; no reps needed, we&apos;ll use the values as-is.
      </p>
      <div className={styles.dataRows}>
        <label htmlFor={inputId} className={styles.dataRowLabel}>
          Training-maxes CSV
        </label>
        <input
          ref={fileInputRef}
          id={inputId}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFile}
          aria-describedby={
            error
              ? `${inputId}-error`
              : fileName && rows !== null && rows.length > 0
                ? summaryId
                : undefined
          }
        />
      </div>
      {error && (
        <p
          id={`${inputId}-error`}
          role="alert"
          className={`${styles.infoBox} ${styles.infoBoxError}`}
        >
          {error}
        </p>
      )}
      {fileName && rows !== null && (
        rows.length === 0 ? (
          <p className={styles.infoBox}>
            All rows removed.{' '}
            <button
              type="button"
              className={styles.inlineLinkBtn}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload a new file
            </button>{' '}
            to start over.
          </p>
        ) : (
          <>
            <p id={summaryId} className={styles.infoBox}>
              Loaded {rows.length} training max{rows.length === 1 ? '' : 'es'} from {fileName}.
              Edit or remove any rows before continuing.
            </p>
            <div className={styles.dataRows} aria-label="Imported training maxes">
              {rows.map((row, i) => (
                <div key={`${uploadGen.current}-${row.lift}`} className={styles.dataRow}>
                  <span className={styles.maxEditLiftName}>{row.lift}</span>
                  <input
                    type="number"
                    className={styles.numberInput}
                    value={row.weight}
                    min={1}
                    step="0.01"
                    aria-label={`Weight for ${row.lift}`}
                    onChange={(e) => updateWeight(i, e.target.value)}
                  />
                  <span className={styles.unitLabel}>lbs</span>
                  <button
                    type="button"
                    className={styles.removeLiftBtn}
                    onClick={() => removeRow(i)}
                    aria-label={`Remove ${row.lift}`}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}
