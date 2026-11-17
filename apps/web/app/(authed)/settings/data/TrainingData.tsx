'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataSnapshotSummary, LiftRecordExportPartsResponse, TrainingDataCounts } from '@lifting-logbook/types';
import { ApiClientError } from '@lifting-logbook/api-client';
import {
  clearTrainingData,
  deleteSnapshot,
  downloadSnapshotLiftRecords,
  fetchSnapshotLiftRecordParts,
  fetchSnapshots,
  fetchTrainingDataCounts,
  restoreSnapshot,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import BusyButton from './BusyButton';
import PartsList from './PartsList';
import { failureMessage } from './saveFile';

/** What each count is, in the order the lifter reads them. */
const COUNT_LABELS: Record<keyof TrainingDataCounts, [one: string, many: string]> = {
  liftRecords: ['logged set', 'logged sets'],
  macrocycles: ['macrocycle', 'macrocycles'],
  macrocycleDashboards: ['program dashboard', 'program dashboards'],
  macrocycleScheduledWorkouts: ['scheduled workout', 'scheduled workouts'],
  trainingMaxes: ['training max', 'training maxes'],
  trainingMaxHistory: ['training max change', 'training max changes'],
  liftModificationMaxes: ['modification max', 'modification maxes'],
  workoutDateOverrides: ['moved workout', 'moved workouts'],
  workoutSkipOverrides: ['skipped workout', 'skipped workouts'],
  workoutLiftOverrides: ['lift change in a workout', 'lift changes in workouts'],
  focusDayStates: ['focus day in progress', 'focus days in progress'],
  importBatches: ['import you could undo', 'imports you could undo'],
};

const COUNT_KEYS = Object.keys(COUNT_LABELS) as (keyof TrainingDataCounts)[];

function total(counts: TrainingDataCounts): number {
  return COUNT_KEYS.reduce((n, key) => n + counts[key], 0);
}

function rows(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'row' : 'rows'}`;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function CountList({ counts }: { counts: TrainingDataCounts }) {
  return (
    <ul>
      {COUNT_KEYS.filter((key) => counts[key] > 0).map((key) => (
        <li key={key}>
          {counts[key].toLocaleString()} {COUNT_LABELS[key][counts[key] === 1 ? 0 : 1]}
        </li>
      ))}
    </ul>
  );
}

/**
 * What a failed change shows. The server's own failures say whether anything changed. When the
 * browser stops waiting, the server may still finish, so the lifter is told to check first.
 */
function writeFailure(err: unknown, fallback: string): string {
  return failureMessage(
    err,
    'No answer came back in time, so this may or may not have finished. Check your backups below before trying again.',
    fallback,
  );
}

/** Clear data and the backups it leaves (#1309, decisions 20 and 21). */
export default function TrainingData() {
  const [snapshots, setSnapshots] = useState<DataSnapshotSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TrainingDataCounts | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Each listing gets its own number, so listing again starts a fresh PartsList.
  const [downloads, setDownloads] = useState<Record<string, { key: number; listing: LiftRecordExportPartsResponse }>>({});
  const listings = useRef(0);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const backupsHeading = useRef<HTMLHeadingElement>(null);
  const confirmOpen = useRef(false);

  /** Re-reads the backups. Returns them, or null if the read failed. */
  const loadSnapshots = useCallback(async (): Promise<DataSnapshotSummary[] | null> => {
    try {
      const list = await fetchSnapshots();
      setSnapshots(list);
      setListError(null);
      return list;
    } catch (err) {
      logClientError('fetchSnapshots', err);
      setListError('Couldn’t load your backups. Reload the page to try again.');
      return null;
    }
  }, []);

  // A restored, deleted or expired backup leaves the list, taking its focused button with it, so
  // focus moves to the Backups heading rather than the page's body. Focus the lifter has moved
  // elsewhere while it ran stays where it is.
  async function reloadAfter(snapshot: DataSnapshotSummary) {
    const focusInRow =
      document.activeElement?.closest('[data-snapshot]')?.getAttribute('data-snapshot') === snapshot.id;
    const list = await loadSnapshots();
    if (focusInRow && list && !list.some((s) => s.id === snapshot.id)) backupsHeading.current?.focus();
  }

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  // Focus follows the confirmation: onto its heading when it opens or its counts change, and back
  // to the button that opened it as soon as it closes (a busy button can still take focus), if
  // closing it left focus on the page's body rather than somewhere the lifter moved it.
  useEffect(() => {
    if (confirming) {
      confirmOpen.current = true;
      confirmHeading.current?.focus();
    } else if (confirmOpen.current) {
      confirmOpen.current = false;
      if (document.activeElement === null || document.activeElement === document.body) {
        clearButton.current?.focus();
      }
    }
  }, [confirming]);

  async function run(action: string, fn: () => Promise<void>) {
    setError(null);
    setDone(null);
    setBusy(action);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const openClear = () =>
    run('counts', async () => {
      try {
        setConfirming(await fetchTrainingDataCounts());
      } catch (err) {
        logClientError('fetchTrainingDataCounts', err);
        setError(
          failureMessage(
            err,
            'Counting your training data took too long, so nothing was cleared. Please try again in a moment.',
            'Couldn’t count your training data. Please try again.',
          ),
        );
      }
    });

  const confirmClear = (counts: TrainingDataCounts) =>
    run('clear', async () => {
      try {
        const { snapshot } = await clearTrainingData(counts);
        setConfirming(null);
        setDone(`Cleared ${rows(total(snapshot.counts))}. The backup is kept until ${day(snapshot.expiresAt)}.`);
        await loadSnapshots();
      } catch (err) {
        logClientError('clearTrainingData', err);
        // Something was stored or removed since the counts were read: show the current ones.
        const current = err instanceof ApiClientError && err.code === 'counts-changed' ? err.body?.['counts'] : undefined;
        if (current) setConfirming(current as TrainingDataCounts);
        setError(writeFailure(err, 'Couldn’t clear your training data. Please try again.'));
        // A clear the browser gave up on may still have saved a backup.
        await loadSnapshots();
      }
    });

  const restore = (snapshot: DataSnapshotSummary) =>
    run(`restore:${snapshot.id}`, async () => {
      try {
        const { restored } = await restoreSnapshot(snapshot.id);
        setDone(`Restored ${rows(total(restored))}.`);
      } catch (err) {
        logClientError('restoreSnapshot', err, { snapshot: snapshot.id });
        setError(writeFailure(err, 'Couldn’t restore this backup. Please try again.'));
      }
      await reloadAfter(snapshot);
    });

  const remove = (snapshot: DataSnapshotSummary) => {
    const ask =
      snapshot.kind === 'overwrite'
        ? `Delete the backup from ${day(snapshot.createdAt)}? The import that replaced this history can’t be undone after that, and this can’t be undone.`
        : `Delete the backup from ${day(snapshot.createdAt)}? This can’t be undone.`;
    if (!window.confirm(ask)) return;
    return run(`delete:${snapshot.id}`, async () => {
      try {
        await deleteSnapshot(snapshot.id);
        setDone('Backup deleted.');
      } catch (err) {
        logClientError('deleteSnapshot', err, { snapshot: snapshot.id });
        setError(writeFailure(err, 'Couldn’t delete this backup. Please try again.'));
      }
      await reloadAfter(snapshot);
    });
  };

  const listParts = (snapshot: DataSnapshotSummary) =>
    run(`parts:${snapshot.id}`, async () => {
      try {
        const listing = await fetchSnapshotLiftRecordParts(snapshot.id);
        const key = (listings.current += 1);
        setDownloads((d) => ({ ...d, [snapshot.id]: { key, listing } }));
      } catch (err) {
        logClientError('fetchSnapshotLiftRecordParts', err, { snapshot: snapshot.id });
        setError(
          failureMessage(
            err,
            'Reading this backup’s sets took too long. Please try again in a moment.',
            'Couldn’t read this backup’s sets. Please try again.',
          ),
        );
      }
    });

  return (
    <>
      <section aria-labelledby="clear-heading">
        <h2 id="clear-heading">Clear training data</h2>
        <p>
          Removes your logged sets, macrocycles, training maxes and workout changes, so you can
          start again or import a clean history. Your setup stays: custom programs and lifts, lift
          settings and modifications, body weight, strength goals, focus blocks and settings.
        </p>
        {!confirming && (
          <BusyButton ref={clearButton} onClick={openClear} busy={busy !== null}>
            {busy === 'counts' ? 'Counting…' : 'Clear training data…'}
          </BusyButton>
        )}
        {confirming && (
          <div role="group" aria-labelledby="clear-confirm-heading">
            <h3 id="clear-confirm-heading" ref={confirmHeading} tabIndex={-1}>
              {total(confirming) > 0 ? `Clear ${rows(total(confirming))}?` : 'There’s nothing to clear'}
            </h3>
            {total(confirming) > 0 && (
              <>
                <p>This clears:</p>
                <CountList counts={confirming} />
                <p>
                  A backup is saved first and kept for 30 days. Until then you can restore it or
                  download its sets under Backups below. After 30 days it&apos;s deleted for good.
                </p>
                <BusyButton onClick={() => confirmClear(confirming)} busy={busy !== null}>
                  {busy === 'clear' ? 'Clearing…' : `Clear ${rows(total(confirming))}`}
                </BusyButton>{' '}
              </>
            )}
            <button type="button" onClick={() => setConfirming(null)} disabled={busy === 'clear'}>
              Cancel
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        {done && <p role="status">{done}</p>}
      </section>

      <section aria-labelledby="backups-heading">
        <h2 id="backups-heading" ref={backupsHeading} tabIndex={-1}>
          Backups
        </h2>
        {listError && <p role="alert">{listError}</p>}
        {snapshots?.length === 0 && <p>No backups. Clearing your training data saves one here for 30 days.</p>}
        {snapshots && snapshots.length > 0 && (
          <ul>
            {snapshots.map((s) => {
              const download = downloads[s.id];
              return (
              <li key={s.id} data-snapshot={s.id}>
                {s.kind === 'overwrite' ? (
                  // Restoring it here would put the history back beside the import that replaced it,
                  // so undoing that import is how it comes back (#1182).
                  <p>
                    From an import that replaced stored history on {day(s.createdAt)}: {rows(total(s.counts))}.
                    Undo that import from History’s Macrocycles tab to put it back. Kept until {day(s.expiresAt)}.
                  </p>
                ) : (
                  <p>
                    From clearing your data on {day(s.createdAt)}: {rows(total(s.counts))}. Kept until{' '}
                    {day(s.expiresAt)}.
                  </p>
                )}
                {s.kind !== 'overwrite' && (
                  <>
                    <BusyButton onClick={() => restore(s)} busy={busy !== null}>
                      {busy === `restore:${s.id}` ? 'Restoring…' : 'Restore'}
                    </BusyButton>{' '}
                  </>
                )}
                <BusyButton onClick={() => listParts(s)} busy={busy !== null}>
                  {busy === `parts:${s.id}` ? 'Reading sets…' : 'Download sets'}
                </BusyButton>{' '}
                <BusyButton onClick={() => remove(s)} busy={busy !== null}>
                  {busy === `delete:${s.id}` ? 'Deleting…' : 'Delete'}
                </BusyButton>
                {download && (
                  <PartsList
                    key={download.key}
                    listing={download.listing}
                    download={(part) => downloadSnapshotLiftRecords(s.id, part, download.listing.split)}
                    fileNamePrefix="backup-"
                    op="downloadSnapshotLiftRecords"
                    context={{ snapshot: s.id }}
                  />
                )}
              </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
