'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SUPPLEMENT_TEXT_MAX } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import { updateSupplementSettings } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import type { Stack } from '@/lib/supplementsView';
import { BulkDialog } from './BulkDialogs';
import styles from './supplements.module.css';

interface Row {
  id: string;
  name: string;
  /** 24-hour `HH:MM`, or empty for a day with no session. */
  sessionTime: string;
}

/** What a save sends, and so what the stack has once it succeeds. */
export type DaySettings = Pick<Stack, 'dayTypes' | 'caffeineCutoff'>;

interface Props {
  stack: Stack;
  onCancel: () => void;
  /** A successful save, with the day types and cutoff saved. */
  onDone: (saved: DaySettings) => void;
}

/** A status the API gives a reason for (a workout dose left with no day type) is shown as it says it. */
const reasonOf = (err: unknown): string | undefined =>
  err instanceof Error && 'status' in err && err.status === 400 ? err.message : undefined;

/**
 * `Edit days`: add, rename and remove day types, set their session times and the caffeine cutoff,
 * saved together by one `PUT /supplements/settings`. Nothing is sent until Save, so × on a row only
 * edits the form; a failed save keeps every field as the lifter left it.
 */
export function DayTypesDialog({ stack, onCancel, onDone }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => stack.dayTypes.map((d) => ({ id: d.id, name: d.name, sessionTime: d.sessionTime ?? '' })));
  const [cutoff, setCutoff] = useState(stack.caffeineCutoff);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // The row just added, whose name takes focus; and where focus goes once a row's × removes it.
  const [addedId, setAddedId] = useState<string | undefined>();
  const [focusAfterRemove, setFocusAfterRemove] = useState<string | 'add' | undefined>();
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusAfterRemove === undefined) return;
    (focusAfterRemove === 'add' ? addButton.current : removeButtons.current.get(focusAfterRemove))?.focus();
    setFocusAfterRemove(undefined);
  }, [focusAfterRemove]);

  const patch = (id: string, change: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...change } : r)));
  // A new day type's id is never one used before: the API keeps doses on a day type by id, so an
  // id reused from a removed day type would carry that day's doses onto the new one, and a removed
  // item restored later would come back on it.
  const add = () => {
    const id = crypto.randomUUID();
    setAddedId(id);
    setRows((rs) => [...rs, { id, name: 'New day', sessionTime: '' }]);
  };
  const remove = (i: number) => {
    setFocusAfterRemove(rows[i + 1]?.id ?? rows[i - 1]?.id ?? 'add');
    setRows((rs) => rs.filter((_, n) => n !== i));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (rows.some((r) => r.name.trim() === '')) return setError('Every day type needs a name.');
    if (cutoff === '') return setError('Set a caffeine cutoff time.');
    setBusy(true);
    setError(undefined);
    const saved: DaySettings = {
      dayTypes: rows.map((r) => ({ id: r.id, name: r.name.trim(), ...(r.sessionTime ? { sessionTime: r.sessionTime } : {}) })),
      caffeineCutoff: cutoff,
    };
    try {
      await updateSupplementSettings(saved, localToday());
      router.refresh();
      onDone(saved);
    } catch (err) {
      logClientError('supplements.editDays', err, { dayTypes: rows.length });
      setError(reasonOf(err) ?? 'Couldn’t save the day types. What you entered is still here; try again.');
      setBusy(false);
    }
  }

  return (
    <BulkDialog
      id="supp-days-title"
      title="Day types"
      subtitle="Daily items apply to all of them unless limited. Workout items are picked per day type."
      busy={busy}
      onCancel={onCancel}
    >
      <form className={styles.form} onSubmit={submit}>
        {rows.map((r, i) => {
          // Every row has a Name and a Session time, so each says which day type it belongs to.
          const day = r.name.trim() || `day type ${i + 1}`;
          return (
            <div key={r.id} className={styles.dayRow}>
              <label>
                Name
                <input
                  required
                  aria-label={`Name of day type ${i + 1}`}
                  maxLength={SUPPLEMENT_TEXT_MAX.name}
                  value={r.name}
                  autoFocus={r.id === addedId}
                  onFocus={(e) => e.currentTarget.value === 'New day' && e.currentTarget.select()}
                  onChange={(e) => patch(r.id, { name: e.target.value })}
                />
              </label>
              <label>
                Session time
                <input
                  type="time"
                  aria-label={`Session time for ${day}`}
                  value={r.sessionTime}
                  onChange={(e) => patch(r.id, { sessionTime: e.target.value })}
                />
              </label>
              <button
                ref={(el) => {
                  if (el) removeButtons.current.set(r.id, el);
                  else removeButtons.current.delete(r.id);
                }}
                type="button"
                className={styles.removeDay}
                aria-label={`Remove ${day}`}
                onClick={() => remove(i)}
              >
                ×
              </button>
            </div>
          );
        })}
        <button ref={addButton} type="button" className={styles.addLink} onClick={add}>
          + Add day type
        </button>
        <p className={styles.muted}>
          Examples: Match day, Long run, Two-a-day, Travel day. Leave the time empty for days without a session. Each day type gets its own
          pre-, intra- and post-workout lists.
        </p>
        <label>
          Caffeine cutoff
          <input type="time" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
        </label>
        <p className={styles.muted}>Flags stimulants in sessions after this time.</p>
        {error && <p role="alert">{error}</p>}
        <div className={styles.formButtons}>
          <button type="submit" disabled={busy}>
            Save
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </BulkDialog>
  );
}
