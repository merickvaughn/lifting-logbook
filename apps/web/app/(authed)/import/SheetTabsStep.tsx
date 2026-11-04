'use client';

import { useEffect, useState } from 'react';
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

/** The kind a tab is offered as: the classifier's pick, else its strongest alternative. */
function suggestedKind(tab: GoogleSheetTab): ImportKind {
  return tab.classification.type ?? tab.classification.alternatives[0]?.type ?? 'lift-records';
}

function previewKey(programId: string, tabName: string, kind: ImportKind): string {
  return [programId, tabName, kind].join('\u0000');
}

type TabPreview ={ status: 'loading' } | { status: 'ready'; res: ImportPreviewResponse } | { status: 'error'; message: string };

/**
 * Workbook overview for a Google Sheets import (#1111): every importable tab
 * with what it was detected as, and — for each checked tab — a live preview
 * from the regular Smart Import endpoint (column mapping and create/skip
 * counts), so you can see what will be imported before stepping through each
 * tab's review.
 */
export function SheetTabsStep({
  programId,
  tabs,
  choices,
  onChange,
}: {
  programId: string;
  tabs: GoogleSheetTab[];
  choices: SheetTabChoices;
  onChange: (next: SheetTabChoices) => void;
}) {
  const importable = tabs.filter((t) => t.csv !== null);
  const skipped = tabs.filter((t) => t.csv === null);
  const [previews, setPreviews] = useState<Record<string, TabPreview>>({});

  // Preview every checked tab under its chosen kind. Keyed by program, name and
  // kind, so changing either fetches a fresh preview and changing back reuses it.
  useEffect(() => {
    for (const [name, kind] of Object.entries(choices)) {
      const key = previewKey(programId, name, kind);
      if (previews[key]) continue;
      const tab = tabs.find((t) => t.name === name);
      if (!tab) continue;
      setPreviews((prev) => ({ ...prev, [key]: { status: 'loading' } }));
      previewImport(programId, tabFile(tab), kind)
        .then((res) => setPreviews((prev) => ({ ...prev, [key]: { status: 'ready', res } })))
        .catch((e: unknown) => {
          logClientError('previewImport', e, { programId, source: 'google-sheet' });
          setPreviews((prev) => ({
            ...prev,
            [key]: { status: 'error', message: e instanceof Error ? e.message : 'Preview failed' },
          }));
        });
    }
  }, [choices, previews, programId, tabs]);

  function toggle(tab: GoogleSheetTab, checked: boolean) {
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
                const p = kind ? previews[previewKey(programId, tab.name, kind)] : undefined;
                return (
                  <tr key={tab.name}>
                    <td>{i + 1}</td>
                    <td>
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={kind !== undefined}
                        onChange={(e) => toggle(tab, e.target.checked)}
                      />
                    </td>
                    <td>
                      <label htmlFor={checkboxId} className={styles.sourceHeaderCell}>
                        {tab.name}
                      </label>
                    </td>
                    <td>
                      <select
                        className={styles.mappingSelect}
                        aria-label={`Import ${tab.name} as`}
                        value={kind ?? suggestedKind(tab)}
                        disabled={kind === undefined}
                        onChange={(e) => {
                          const picked = ALL_KINDS.find((k) => k === e.target.value);
                          if (picked) onChange({ ...choices, [tab.name]: picked });
                        }}
                      >
                        {ALL_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABEL[k]}
                            {k === tab.classification.type
                              ? ` (detected, ${Math.round(tab.classification.confidence * 100)}%)`
                              : ''}
                          </option>
                        ))}
                      </select>
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
              <li key={t.name}>{t.name}</li>
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
