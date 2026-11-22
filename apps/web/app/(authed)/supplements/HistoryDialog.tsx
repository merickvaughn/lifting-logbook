'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SupplementAsOfResponse, SupplementChange } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import { fetchSupplementChanges, fetchSupplementsAsOf, restoreSupplementItem } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { describeChanges, dosesText, formatDay, isIsoDay, restorableSeqs, shortDay } from '@/lib/supplementHistory';
import type { Stack } from '@/lib/supplementsView';
import { BulkDialog } from './BulkDialogs';
import styles from './supplements.module.css';

/** The change log is read this many changes at a time. */
export const HISTORY_PAGE = 200;

const LOAD_ERROR = 'Couldn’t load the history. Close this and try again in a moment.';

type Removal = Extract<SupplementChange, { type: 'removed' }>;

/**
 * Supplement history (#1378): the stack at the end of any date, replayed from the change log, and
 * the log newest first, with Restore on a removal that can still be undone. `stack` is the stack
 * now; `initialDate` is the date to open at, today by default.
 */
export default function HistoryDialog({ stack, initialDate, onClose }: { stack: Stack; initialDate?: string; onClose: () => void }) {
  const router = useRouter();
  const today = useMemo(() => localToday(), []);
  // What the date field holds, and the last whole date it held, which is the one shown.
  const [draft, setDraft] = useState(initialDate ?? today);
  const [date, setDate] = useState(initialDate ?? today);
  const [asOf, setAsOf] = useState<{ date: string; data: SupplementAsOfResponse }>();
  const [asOfVersion, setAsOfVersion] = useState(0);
  const [asOfError, setAsOfError] = useState<string>();
  // The loaded log by `seq`, so pages and re-reads can overlap without listing a change twice.
  const [log, setLog] = useState<ReadonlyMap<number, SupplementChange>>(new Map());
  const [logLoaded, setLogLoaded] = useState(false);
  const [logError, setLogError] = useState<string>();
  const [exhausted, setExhausted] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string>();
  const [restoring, setRestoring] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  // The stack a restore returned, until the refresh brings a newer `stack`.
  const [restored, setRestored] = useState<{ against: Stack; stack: Stack }>();
  const asOfRequest = useRef(0);
  const changesHeading = useRef<HTMLHeadingElement>(null);

  const current = restored?.against === stack ? restored.stack : stack;
  const merge = (page: readonly SupplementChange[]) =>
    setLog((prev) => {
      const next = new Map(prev);
      for (const c of page) next.set(c.seq, c);
      return next;
    });

  useEffect(() => {
    let live = true;
    fetchSupplementChanges({ limit: HISTORY_PAGE }).then(
      (page) => {
        if (!live) return;
        merge(page);
        setExhausted(page.length < HISTORY_PAGE);
        setLogLoaded(true);
      },
      (err: unknown) => {
        if (!live) return;
        logClientError('supplements.history.load', err, { part: 'changes' });
        setLogError(LOAD_ERROR);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // Only the latest request for a date is shown: an earlier one that answers late is dropped.
  useEffect(() => {
    const request = ++asOfRequest.current;
    fetchSupplementsAsOf(date).then(
      (data) => {
        if (request !== asOfRequest.current) return;
        setAsOf({ date, data });
        setAsOfError(undefined);
      },
      (err: unknown) => {
        if (request !== asOfRequest.current) return;
        logClientError('supplements.history.load', err, { part: 'asOf', date });
        setAsOfError(LOAD_ERROR);
      },
    );
  }, [date, asOfVersion]);

  const changes = useMemo(() => [...log.values()], [log]);
  const words = useMemo(() => describeChanges(changes, current.items), [changes, current.items]);
  const restorable = useMemo(() => restorableSeqs(changes, current), [changes, current]);
  const newestFirst = useMemo(() => [...changes].sort((a, b) => b.seq - a.seq), [changes]);
  const shown = asOf?.date === date ? asOf.data : undefined;

  // Restore and Show earlier changes are disabled while they work, so neither runs twice at once.
  async function restore(change: Removal) {
    setRestoring(change.seq);
    setRestoreError(undefined);
    let ok = false;
    try {
      setRestored({ against: stack, stack: await restoreSupplementItem(change.item.id, localToday()) });
      ok = true;
    } catch (err) {
      logClientError('supplements.restoreItem', err, { itemId: change.item.id });
      setRestoreError(`Couldn’t restore ${change.item.name}. Try again in a moment.`);
    } finally {
      setRestoring(null);
    }
    if (!ok) return;
    setAnnouncement(`Restored ${change.item.name}.`);
    // The Restore button goes, so focus moves to the list it was in.
    changesHeading.current?.focus();
    router.refresh();
    setAsOfVersion((v) => v + 1);
    try {
      merge(await fetchSupplementChanges({ limit: HISTORY_PAGE }));
    } catch (err) {
      logClientError('supplements.history.load', err, { part: 'changes' });
      setLogError(LOAD_ERROR);
    }
  }

  async function loadEarlier() {
    setLoadingEarlier(true);
    const beforeSeq = Math.min(...log.keys());
    try {
      const page = await fetchSupplementChanges({ beforeSeq, limit: HISTORY_PAGE });
      merge(page);
      setEarlierError(undefined);
      if (page.length < HISTORY_PAGE) setExhausted(true);
    } catch (err) {
      logClientError('supplements.history.loadEarlier', err, { beforeSeq });
      setEarlierError('Couldn’t load earlier changes. Try again in a moment.');
    } finally {
      setLoadingEarlier(false);
    }
  }

  const active = shown?.items.filter((i) => i.status === 'active') ?? [];
  const before = shown !== undefined && shown.firstChangeDate !== null && date < shown.firstChangeDate;

  return (
    <BulkDialog
      id="supp-history-title"
      title="Supplement history"
      subtitle="Every change is kept: see what you were on for any date, and bring back anything you removed."
      busy={restoring !== null}
      onCancel={onClose}
    >
      <p className={styles.srOnly} aria-live="polite" data-testid="history-announcement">
        {announcement}
      </p>

      <section aria-labelledby="supp-history-on">
        <h3 id="supp-history-on" className={styles.sectionHeading}>
          What was I on?
        </h3>
        <label className={styles.historyField}>
          Date
          <input
            type="date"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (isIsoDay(e.target.value)) setDate(e.target.value);
            }}
          />
        </label>
        {asOfError ? (
          <p role="alert">{asOfError}</p>
        ) : !shown ? (
          <p className={styles.muted}>Loading…</p>
        ) : shown.firstChangeDate === null ? (
          <p className={styles.empty}>Nothing has been logged yet, so there’s no history to show.</p>
        ) : (
          <>
            <p>
              {active.length} item{active.length === 1 ? '' : 's'} active at the end of that day.
              {before && ` History starts on ${formatDay(shown.firstChangeDate)}.`}
            </p>
            {active.length > 0 && (
              <ul className={styles.historyItems}>
                {active.map((item) => (
                  <li key={item.id}>
                    <span className={styles.name}>{item.name}</span> — {dosesText(item, shown.dayTypes)}
                  </li>
                ))}
              </ul>
            )}
            {shown.anomalies.length > 0 && <p className={styles.muted}>Some changes couldn’t be replayed, so this list may be incomplete.</p>}
          </>
        )}
      </section>

      <section aria-labelledby="supp-history-changes">
        <h3 id="supp-history-changes" ref={changesHeading} tabIndex={-1} className={styles.sectionHeading}>
          Changes
        </h3>
        {restoreError && <p role="alert">{restoreError}</p>}
        {logError && <p role="alert">{logError}</p>}
        {!logLoaded ? (
          !logError && <p className={styles.muted}>Loading…</p>
        ) : newestFirst.length === 0 ? (
          <p className={styles.empty}>No changes yet.</p>
        ) : (
          <ul className={styles.list}>
            {newestFirst.map((c) => {
              const w = words.get(c.seq);
              return (
                <li key={c.seq} className={styles.change}>
                  <span className={styles.changeDate}>{shortDay(c.date, today)}</span>
                  <span className={styles.changeText}>
                    <strong>{w?.verb}</strong> {w?.object}
                    {c.type === 'added' && c.note && <span className={styles.line2}>{c.note}</span>}
                  </span>
                  {c.type === 'removed' && restorable.has(c.seq) && (
                    <button type="button" disabled={restoring !== null} aria-label={`Restore ${c.item.name}`} onClick={() => restore(c)}>
                      {restoring === c.seq ? 'Restoring…' : 'Restore'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {logLoaded && !exhausted && (
          <button type="button" className={styles.addLink} disabled={loadingEarlier} onClick={loadEarlier}>
            {loadingEarlier ? 'Loading earlier changes…' : 'Show earlier changes'}
          </button>
        )}
        {earlierError && <p role="alert">{earlierError}</p>}
      </section>
    </BulkDialog>
  );
}
