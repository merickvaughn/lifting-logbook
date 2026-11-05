'use client';

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { GoogleSheetTab, ImportKind, ImportPreviewResponse } from '@lifting-logbook/types';
import { previewImport } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { ALL_KINDS, KIND_LABEL } from './steps';
import styles from './import.module.css';

/** Tab name → the destination it will be imported as. A tab absent from the map is not imported. */
export type SheetTabChoices = Record<string, ImportKind>;

/**
 * Kinds pre-selected when a workbook loads. Strength goals and program spec
 * are listed but start unchecked: a program-spec import rewrites the program.
 */
const DEFAULT_KINDS: readonly ImportKind[] = ['lift-records', 'training-maxes'];

/** Builds the CSV `File` the Smart Import endpoints expect from a fetched tab. */
export function tabFile(tab: Pick<GoogleSheetTab, 'name' | 'csv'>): File {
  return new File([tab.csv ?? ''], `${tab.name}.csv`, { type: 'text/csv' });
}

/** Pre-selects the most confident tab for each default kind. */
export function defaultTabChoices(tabs: GoogleSheetTab[]): SheetTabChoices {
  const choices: SheetTabChoices = {};
  for (const kind of DEFAULT_KINDS) {
    const best = tabs
      .filter((t) => t.csv !== null && t.classification.type === kind)
      .sort((a, b) => b.classification.confidence - a.classification.confidence)[0];
    if (best) choices[best.name] = kind;
  }
  return choices;
}

/**
 * The kind a tab is offered as. Every tab with a CSV has a `suggestedKind` (the API
 * sets `csv` only then), so the fallback is never reached for a tab that can be checked.
 */
function suggestedKind(tab: GoogleSheetTab): ImportKind {
  return tab.suggestedKind ?? 'lift-records';
}

/** Identifies one preview: which workbook fetch, program, tab and kind it was taken for. */
export function previewKey(workbookId: number, programId: string, tabName: string, kind: ImportKind): string {
  return [workbookId, programId, tabName, kind].join('\u0000');
}

export type TabPreview =
  | { status: 'loading' }
  | { status: 'ready'; res: ImportPreviewResponse }
  | { status: 'error'; message: string };

/** Overview previews by `previewKey`. Owned by the wizard so a started tab can reuse its preview. */
export type TabPreviews = Record<string, TabPreview>;

/**
 * Workbook overview for a Google Sheets import (#1111): every importable tab
 * with what it was detected as, and — for each checked tab — a live preview
 * from the regular Smart Import endpoint (column mapping and create/skip
 * counts), so you can see what will be imported before stepping through each
 * tab's review.
 */
export function SheetTabsStep({
  workbookId,
  programId,
  tabs,
  kinds,
  choices,
  onChange,
  previews,
  setPreviews,
}: {
  /** Changes on every workbook fetch, so a response for an earlier workbook is never shown for this one. */
  workbookId: number;
  programId: string;
  tabs: GoogleSheetTab[];
  /** What the selected program can take. A tab detected as anything else can't be checked. */
  kinds: ImportKind[];
  choices: SheetTabChoices;
  onChange: (next: SheetTabChoices) => void;
  previews: TabPreviews;
  setPreviews: Dispatch<SetStateAction<TabPreviews>>;
}) {
  const importable = tabs.filter((t) => t.csv !== null);
  const skipped = tabs.filter((t) => t.csv === null);
  // Guards against a second request for the same key before the 'loading' entry
  // has rendered (React StrictMode runs effects twice on mount).
  const inFlight = useRef<string | null>(null);
  const keyFor = (tabName: string, kind: ImportKind) => previewKey(workbookId, programId, tabName, kind);

  // Preview the checked tabs under their chosen kinds, one request at a time.
  // Keyed by workbook, program, name and kind, so changing any of them fetches a
  // fresh preview and changing back reuses it.
  useEffect(() => {
    if (inFlight.current || Object.values(previews).some((p) => p.status === 'loading')) return;
    const pending = Object.entries(choices).find(([name, kind]) => !previews[previewKey(workbookId, programId, name, kind)]);
    if (!pending) return;
    const [name, kind] = pending;
    const tab = tabs.find((t) => t.name === name);
    if (!tab) return;
    const key = previewKey(workbookId, programId, name, kind);
    inFlight.current = key;
    setPreviews((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    previewImport(programId, tabFile(tab), kind)
      .then((res) => setPreviews((prev) => ({ ...prev, [key]: { status: 'ready', res } })))
      .catch((e: unknown) => {
        logClientError('previewImport', e, { programId, source: 'google-sheet' });
        setPreviews((prev) => ({
          ...prev,
          [key]: { status: 'error', message: e instanceof Error ? e.message : 'Preview failed' },
        }));
      })
      .finally(() => {
        inFlight.current = null;
      });
  }, [choices, previews, workbookId, programId, tabs, setPreviews]);

  // A failed preview is not retried automatically (it would loop on a persistent
  // error); toggling the tab or changing its kind clears it so it is fetched again.
  function clearFailedPreviews(tabName: string) {
    setPreviews((prev) => {
      const next = { ...prev };
      for (const kind of ALL_KINDS) {
        const key = keyFor(tabName, kind);
        if (next[key]?.status === 'error') delete next[key];
      }
      return next;
    });
  }

  function toggle(tab: GoogleSheetTab, checked: boolean) {
    clearFailedPreviews(tab.name);
    const next = { ...choices };
    if (checked) next[tab.name] = suggestedKind(tab);
    else delete next[tab.name];
    onChange(next);
  }

  return (
    <>
      <h2 className={styles.stepTitle}>Choose tabs to import</h2>
      {importable.length === 0 ? (
        <p className={styles.infoBox}>
          No tab in this workbook looks like lift history, training maxes, strength goals or a
          program.
        </p>
      ) : (
        <>
          <p className={styles.stepHint}>
            Each checked tab is reviewed and committed on its own, in the order listed.
          </p>
          <table className={styles.mappingTable}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Import</th>
                <th scope="col">Tab</th>
                <th scope="col">Import as</th>
                <th scope="col">Rows</th>
                <th scope="col">Preview</th>
              </tr>
            </thead>
            <tbody>
              {importable.map((tab, i) => {
                const kind = choices[tab.name];
                const checkboxId = `sheet-tab-${i}`;
                const p = kind ? previews[keyFor(tab.name, kind)] : undefined;
                const unavailable = kind === undefined && !kinds.includes(suggestedKind(tab));
                return (
                  <tr key={tab.name}>
                    <td>{i + 1}</td>
                    <td>
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={kind !== undefined}
                        disabled={unavailable}
                        onChange={(e) => toggle(tab, e.target.checked)}
                      />
                    </td>
                    <td>
                      <label htmlFor={checkboxId} className={styles.sourceHeaderCell}>
                        {tab.name}
                      </label>
                    </td>
                    <td>
                      {unavailable ? (
                        <span className={styles.stepHint}>
                          {KIND_LABEL[suggestedKind(tab)]}: needs a custom program
                        </span>
                      ) : (
                        <select
                          className={styles.mappingSelect}
                          aria-label={`Import ${tab.name} as`}
                          value={kind ?? suggestedKind(tab)}
                          disabled={kind === undefined}
                          onChange={(e) => {
                            const picked = kinds.find((k) => k === e.target.value);
                            if (!picked) return;
                            clearFailedPreviews(tab.name);
                            onChange({ ...choices, [tab.name]: picked });
                          }}
                        >
                          {kinds.map((k) => (
                            <option key={k} value={k}>
                              {KIND_LABEL[k]}
                              {k === tab.suggestedKind
                                ? ` (${tab.classification.type ? 'detected' : 'best guess'}, ${Math.round(tab.classification.confidence * 100)}%)`
                                : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>{Math.max(tab.rowCount - 1, 0)}</td>
                    <td>{kind === undefined ? '—' : <PreviewCell preview={p} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {skipped.length > 0 && (
        <details>
          <summary className={styles.stepHint}>
            {skipped.length} tab{skipped.length === 1 ? '' : 's'} not importable
          </summary>
          <ul className={styles.reasonList}>
            {skipped.map((t) => (
              <li key={t.name}>
                {t.name}
                {t.skipReason ? ` — ${t.skipReason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function PreviewCell({ preview }: { preview: TabPreview | undefined }) {
  if (!preview || preview.status === 'loading') return <span className={styles.stepHint}>Previewing…</span>;
  if (preview.status === 'error') return <span className={styles.errorNote}>{preview.message}</span>;
  const { res } = preview;
  const mapped = (res.columnMappings ?? []).filter((m) => m.sourceHeader && m.destinationField);
  const unmapped = (res.columnMappings ?? []).filter((m) => m.required && !m.sourceHeader);
  return (
    <div>
      {res.preview ? (
        <span>
          {res.preview.creates} new · {res.preview.updates} updated · {res.preview.skips} skipped
          {res.preview.unresolved > 0 ? ` · ${res.preview.unresolved} to review` : ''}
        </span>
      ) : (
        <span className={styles.errorNote}>
          {res.errors.length} row error{res.errors.length === 1 ? '' : 's'} to fix in review
        </span>
      )}
      <details>
        <summary className={styles.stepHint}>
          {mapped.length} column{mapped.length === 1 ? '' : 's'} matched
          {unmapped.length > 0 ? `, ${unmapped.length} required missing` : ''}
        </summary>
        <ul className={styles.reasonList}>
          {mapped.map((m) => (
            <li key={m.sourceHeader}>
              {m.sourceHeader} → {m.destinationField} ({Math.round(m.confidence * 100)}%)
            </li>
          ))}
          {unmapped.map((m) => (
            <li key={`missing-${m.destinationField}`}>{m.destinationField}: not found</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
