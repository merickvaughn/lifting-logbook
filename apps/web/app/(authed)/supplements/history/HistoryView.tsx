'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SupplementAsOfResponse, SupplementChange, SupplementStackResponse } from '@lifting-logbook/types';
import { fetchSupplementChanges, restoreSupplementItem } from '@/lib/client-api';
import { localToday } from '@/lib/calendarDay';
import { logClientError } from '@/lib/log-client-error';
import { describeChanges, doseText, formatDay, groupStack, restorableSeqs, STACK_GROUP_LABEL } from '@/lib/supplementHistory';
import styles from '../supplements.module.css';

/** The change log is paged this many at a time, the API's default page. */
const PAGE = 200;

export default function HistoryView({
  date,
  asOf,
  changes,
  current,
}: {
  date: string;
  asOf: SupplementAsOfResponse;
  /** The latest page of the change log, oldest first. */
  changes: SupplementChange[];
  current: SupplementStackResponse;
}) {
  const router = useRouter();
  const [older, setOlder] = useState<SupplementChange[]>([]);
  const [exhausted, setExhausted] = useState(changes.length < PAGE);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const log = useMemo(() => [...older, ...changes], [older, changes]);
  const words = useMemo(() => describeChanges(log, current.items), [log, current.items]);
  const restorable = useMemo(() => restorableSeqs(log, current), [log, current]);
  const newestFirst = useMemo(() => [...log].sort((a, b) => b.seq - a.seq), [log]);
  const groups = useMemo(() => groupStack(asOf.items), [asOf.items]);

  const before = asOf.firstChangeDate !== null && date < asOf.firstChangeDate;

  async function restore(change: Extract<SupplementChange, { type: 'removed' }>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await restoreSupplementItem(change.item.id, localToday());
      setAnnouncement(`Restored ${change.item.name}`);
      router.refresh();
    } catch (err) {
      logClientError('supplements.restoreItem', err, { itemId: change.item.id });
      setError(`Couldn’t restore ${change.item.name}. Try again in a moment.`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function loadEarlier() {
    const first = log[0];
    if (!first) return;
    try {
      const page = await fetchSupplementChanges({ beforeSeq: first.seq });
      setOlder((o) => [...page, ...o]);
      if (page.length < PAGE) setExhausted(true);
    } catch (err) {
      logClientError('supplements.loadEarlierChanges', err);
      setError('Couldn’t load earlier changes. Try again in a moment.');
    }
  }

  return (
    <div>
      <p className={styles.srOnly} aria-live="polite" data-testid="supp-announcement">
        {announcement}
      </p>

      <section>
        <h2 className={styles.cardTitle}>
          <label htmlFor="supp-asof-date">What was I on?</label>
        </h2>
        <input
          id="supp-asof-date"
          type="date"
          value={date}
          onChange={(e) => {
            if (e.target.value) router.push(`/supplements/history?date=${e.target.value}`);
          }}
        />

        {asOf.firstChangeDate === null ? (
          <p className={styles.empty}>Nothing has been logged yet, so there’s no history to show.</p>
        ) : before ? (
          <p className={styles.empty}>
            History starts on {formatDay(asOf.firstChangeDate)}; nothing was logged before then.
          </p>
        ) : groups.length === 0 ? (
          <p className={styles.empty}>Nothing in the stack at the end of {formatDay(date)}.</p>
        ) : (
          groups.map((g) => (
            <div key={g.key}>
              <h3 className={styles.slotHeading}>{STACK_GROUP_LABEL[g.key]}</h3>
              <ul className={styles.list}>
                {g.items.map((item) => (
                  <li key={item.id} className={styles.row}>
                    <span className={styles.name}>{item.name}</span>
                    {item.doses.length === 0 ? (
                      <span className={styles.line2}> · no doses</span>
                    ) : (
                      <ul className={styles.list}>
                        {item.doses.map((d, i) => (
                          <li key={i} className={styles.line2}>
                            {doseText(d, asOf.dayTypes)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        {asOf.anomalies.length > 0 && <p className={styles.muted}>Some changes couldn’t be replayed, so this list may be incomplete.</p>}
      </section>

      <section>
        <h2 className={styles.sectionHeading}>
          Changes
        </h2>
        {error && <p role="alert">{error}</p>}
        {newestFirst.length === 0 ? (
          <p className={styles.empty}>No changes yet.</p>
        ) : (
          <ul className={styles.list}>
            {newestFirst.map((c) => (
              <li key={c.seq} className={styles.row}>
                <span className={styles.line2}>{formatDay(c.date)}</span> <span>{words.get(c.seq)}</span>
                {c.type === 'removed' && restorable.has(c.seq) && (
                  <button type="button" disabled={busy} aria-label={`Restore ${c.item.name}`} onClick={() => restore(c)}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!exhausted && (
          <button type="button" onClick={loadEarlier}>
            Show earlier changes
          </button>
        )}
      </section>
    </div>
  );
}
