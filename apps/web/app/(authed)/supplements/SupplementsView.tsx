'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { localToday } from '@/lib/calendarDay';
import { removeSupplementItems, setSupplementStatus } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { SLOT_LABEL, buildView, type RowModel, type Stack } from '@/lib/supplementsView';
import { CombineDialog, MoveDialog } from './BulkDialogs';
import { DayTypesDialog, type DaySettings } from './DayTypesDialog';
import SupplementDetail from './SupplementDetail';
import SupplementForm, { type FormMode } from './SupplementForm';
import styles from './supplements.module.css';

/** What a row does in Edit stack mode: a checkbox, Edit, and Start on a pending row. */
interface EditControls {
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onStart?: () => void;
}

function Row({ row, onOpen, edit }: { row: RowModel; onOpen: (row: RowModel, opener: HTMLElement) => void; edit?: EditControls }) {
  const flagged = row.advisories.length > 0;
  return (
    <li className={flagged ? `${styles.row} ${styles.flagged}` : styles.row}>
      <button type="button" className={styles.rowButton} onClick={(e) => onOpen(row, e.currentTarget)}>
        <span className={styles.rowMain}>
          <span className={styles.line1}>
            <span className={styles.name}>
              {row.item.name}
              {row.also.length > 0 && <span className={styles.pill}>also {row.also.join(', ').toLowerCase()}</span>}
              {!row.counted && row.item.status === 'active' && <span className={styles.pill}>unverified, not counted</span>}
            </span>
            <span className={styles.dose}>
              {row.amount ? (
                <>
                  {row.amount}
                  {row.range && <span className={styles.muted}> ({row.range})</span>}
                </>
              ) : (
                <em className={styles.muted}>dose?</em>
              )}
              {row.protein && <span className={styles.protein}>{row.protein}</span>}
            </span>
          </span>
          {row.detail && <span className={styles.line2}>{row.detail}</span>}
          {/* The lifter's own words, kept visibly apart from the reference text above. */}
          {row.note && <span className={styles.line3}>{row.note}</span>}
          {row.advisories.map((a) => (
            <span key={a.rule} className={styles.advisory}>
              • {a.line}
            </span>
          ))}
        </span>
        {!edit && (
          <span aria-hidden="true" className={styles.chevron}>
            ›
          </span>
        )}
      </button>
      {edit && (
        <span className={styles.rowControls}>
          {/* An item can have a row in several slots, so the label names which one this is. */}
          <input
            type="checkbox"
            aria-label={`Select ${row.item.name}${row.slot && row.item.status === 'active' ? `, ${SLOT_LABEL[row.slot]}` : ''}`}
            checked={edit.selected}
            onChange={edit.onToggle}
          />
          {edit.onStart && (
            <button type="button" className={styles.startButton} disabled={edit.busy} onClick={edit.onStart} aria-label={`Start ${row.item.name}`}>
              Start
            </button>
          )}
          <button type="button" className={styles.editButton} aria-label={`Edit ${row.item.name}`} onClick={(e) => onOpen(row, e.currentTarget)}>
            Edit
          </button>
        </span>
      )}
    </li>
  );
}

function ColumnHeader() {
  return (
    <div className={styles.columns} aria-hidden="true">
      <span>Item</span>
      <span>Your dose</span>
    </div>
  );
}

const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

/** A row's identity for a tick: the row, plus the slot and status it showed when ticked. */
const selectionKey = (r: RowModel) => `${r.key}|${r.slot ?? ''}|${r.item.status}`;

/** The Supplements page: day-type switcher, protein total, the Workout and Every day cards, Pending, and the detail panel. */
export default function SupplementsView({ stack }: { stack: Stack }) {
  const [dayTypeId, setDayTypeId] = useState(stack.dayTypes[0]?.id ?? '');
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [form, setForm] = useState<FormMode | null>(null);
  // Edit stack mode: rows ticked (by `selectionKey`), the open bulk dialog, the selection a first
  // Remove tap was for, the last write's error, and what the screen reader last heard.
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<'move' | 'combine' | null>(null);
  const [daysOpen, setDaysOpen] = useState(false);
  const daysOpener = useRef<HTMLButtonElement>(null);
  // The day types just saved, until the refresh brings a stack that has them: reopening Edit days
  // before then must start from what was saved, or a second Save would write the old ones back.
  const [savedDays, setSavedDays] = useState<{ against: Stack; settings: DaySettings }>();
  const daysStack = savedDays?.against === stack ? { ...stack, ...savedDays.settings } : stack;
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | undefined>();
  const [announcement, setAnnouncement] = useState('');
  const router = useRouter();
  const opener = useRef<HTMLElement | null>(null);
  // What opened the form, to take focus back when it's saved or closed with ×.
  const formOpener = useRef<HTMLElement | null>(null);
  // The bulk bar's button that opened a dialog, and the Edit stack/Done toggle, for focus when the bar goes.
  const bulkOpener = useRef<HTMLElement | null>(null);
  const modeToggle = useRef<HTMLButtonElement>(null);
  const openForm = (mode: FormMode, el: HTMLElement | null) => {
    formOpener.current = el;
    setForm(mode);
  };
  const view = useMemo(() => buildView(stack, dayTypeId), [stack, dayTypeId]);
  // Every row on screen: in Edit stack mode Pending is always open.
  const shown = useMemo(
    () => [...view.workout.slots, ...view.daily.slots].flatMap((s) => s.rows).concat(view.unscheduled, view.pending),
    [view],
  );

  useEffect(() => {
    if (view.advisoryError) logClientError('supplements.advisories', view.advisoryError, { dayTypeId: view.dayType.id });
  }, [view]);

  // A tick belongs to a row as it was: after a day-type switch, a refresh, Start or an edit, a row
  // that's gone or now shows another slot or status is unticked rather than left selected unseen.
  useEffect(() => {
    const live = new Set(shown.map(selectionKey));
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [shown]);

  const hasDayTypes = stack.dayTypes.length > 0;
  const open = (row: RowModel, el: HTMLElement) => {
    opener.current = el;
    // In Edit stack mode a tap goes straight to the form.
    if (editing) openForm({ kind: 'edit', item: row.item }, el);
    else setOpenId(row.item.id);
  };
  const selectedRows = shown.filter((r) => selected.has(selectionKey(r)));
  const clearSelection = () => {
    setSelected(new Set());
    setConfirmRemove(null);
    setWriteError(undefined);
  };
  /** After a write that empties the selection, the bar goes, so focus moves to Done and the result is announced. */
  const finishBulk = (message: string) => {
    clearSelection();
    setAnnouncement(message);
    modeToggle.current?.focus();
  };
  const controls = (r: RowModel): EditControls | undefined =>
    editing
      ? {
          selected: selected.has(selectionKey(r)),
          busy: writing,
          onToggle: () => {
            const key = selectionKey(r);
            setSelected((prev) => {
              const next = new Set(prev);
              if (!next.delete(key)) next.add(key);
              return next;
            });
          },
          onStart:
            r.item.status === 'pending'
              ? () =>
                  void write('supplements.start', { itemId: r.item.id }, () => setSupplementStatus([r.item.id], 'active', localToday()), {
                    done: `Started ${r.item.name}.`,
                  })
              : undefined,
        }
      : undefined;

  /**
   * Runs a write, then refreshes; on failure reports it and leaves the selection as it was.
   * `clear` empties the selection on success (Start keeps it).
   */
  async function write(
    op: string,
    ctx: Record<string, unknown>,
    run: () => Promise<unknown>,
    { done, clear = false }: { done: string; clear?: boolean },
  ) {
    setWriting(true);
    setWriteError(undefined);
    try {
      await run();
      router.refresh();
      // Either way the button tapped can go (the bar, or a started row's Start), so focus moves to Done.
      if (clear) finishBulk(done);
      else {
        setAnnouncement(done);
        modeToggle.current?.focus();
      }
    } catch (err) {
      logClientError(op, err, ctx);
      setWriteError('Couldn’t save that. Your selection is kept; try again.');
    } finally {
      setWriting(false);
    }
  }
  const itemIds = [...new Set(selectedRows.map((r) => r.item.id))];
  // The selection a first Remove tap was for; a second tap only removes if it hasn't changed since.
  const removeKey = itemIds.join(',');
  const markAll = (status: 'active' | 'pending') =>
    write('supplements.bulkStatus', { status, items: itemIds.length }, () => setSupplementStatus(itemIds, status, localToday()), {
      done: `Marked ${plural(itemIds.length)} ${status}.`,
      clear: true,
    });
  const removeAll = () => {
    if (confirmRemove !== removeKey) return setConfirmRemove(removeKey);
    setConfirmRemove(null);
    // One write removes them all or none (#1414), so a failure leaves the stack as the page shows it.
    return write('supplements.bulkRemove', { items: itemIds.length }, () => removeSupplementItems(itemIds, localToday()), {
      done: `Removed ${plural(itemIds.length)}.`,
      clear: true,
    });
  };
  const rowCount = selectedRows.length;
  const selectedText =
    rowCount === itemIds.length ? `${rowCount} selected` : `${rowCount} rows selected (${plural(itemIds.length)})`;
  const closeDialog = () => {
    setDialog(null);
    bulkOpener.current?.focus();
  };
  const dialogDone = (message: string) => {
    setDialog(null);
    finishBulk(message);
  };
  const openItem = stack.items.find((i) => i.id === openId);
  const noWorkout = !view.dayType.sessionTime && view.workout.count === 0;
  const flagged = view.flaggedCount;

  return (
    <div>
      <div className={styles.toolbar}>
        <button
          ref={modeToggle}
          type="button"
          className={editing ? styles.primary : undefined}
          onClick={() => {
            setEditing((e) => !e);
            clearSelection();
          }}
        >
          {editing ? 'Done' : 'Edit stack'}
        </button>
      </div>
      <p className={styles.srOnly} aria-live="polite" data-testid="supp-announcement">
        {announcement}
      </p>
      <p className={styles.subtitle}>
        {view.activeCount} active · {flagged} item{flagged === 1 ? ' has' : 's have'} a note worth a look · tap any item for details
      </p>

      <div className={styles.dayBar}>
        {hasDayTypes && (
          <div role="group" aria-label="Day type" className={styles.switcher}>
            {stack.dayTypes.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={d.id === view.dayType.id}
                className={d.id === view.dayType.id ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
                onClick={() => setDayTypeId(d.id)}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}
        <button ref={daysOpener} type="button" onClick={() => setDaysOpen(true)}>
          Edit days
        </button>
      </div>

      {editing && (
        <p className={styles.infoBanner} role="status">
          Editing: tap any item to change it, or tick several to move, combine into a mix, or remove them. <strong>Start</strong> moves a
          pending item into your stack.
        </p>
      )}

      {view.advisoryError !== undefined && (
        <p className={styles.muted}>Notes worth a look couldn’t be worked out for this day, so none are shown.</p>
      )}

      <section className={styles.card} aria-label="Supplemental protein">
        <h2 className={styles.cardTitle}>Supplemental protein</h2>
        <p className={styles.bigNumber}>
          {view.protein.total} <small>{view.dayType.name.toLowerCase()}</small>
        </p>
        <p className={styles.muted}>
          {[view.protein.contributors, ...view.protein.others, 'free amino acids (citrulline, taurine, glycine) aren’t counted'].join(' · ')}
        </p>
      </section>

      <section className={styles.card} aria-labelledby="supp-workout">
        <header className={styles.cardHeader}>
          <div>
            <h2 id="supp-workout" className={styles.cardTitle}>
              {hasDayTypes ? `Workout · ${view.dayType.name}` : 'Workout'}
            </h2>
            {hasDayTypes && <p className={styles.muted}>{view.workout.sessionLine}</p>}
          </div>
          <span className={styles.muted}>{plural(view.workout.count)}</span>
        </header>
        {!hasDayTypes ? (
          <p className={styles.empty}>No day types set up yet, so workout doses aren’t shown.</p>
        ) : noWorkout ? (
          <p className={styles.empty}>Nothing workout-specific on rest days.</p>
        ) : (
          <>
            <ColumnHeader />
            {view.workout.slots.map(({ slot, rows }) => (
              <div key={slot}>
                <h3 className={styles.slotHeading}>{SLOT_LABEL[slot]}</h3>
                {rows.length === 0 ? (
                  <p className={styles.empty}>Nothing {slot}-workout</p>
                ) : (
                  <ul className={styles.list}>
                    {rows.map((r) => (
                      <Row key={r.key} row={r} onOpen={open} edit={controls(r)} />
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </>
        )}
        {hasDayTypes && (
          <button type="button" className={styles.addLink} onClick={(e) => openForm({ kind: 'add', preset: 'workout' }, e.currentTarget)}>
            + Add to this day
          </button>
        )}
      </section>

      <section className={styles.card} aria-labelledby="supp-daily">
        <header className={styles.cardHeader}>
          <div>
            <h2 id="supp-daily" className={styles.cardTitle}>
              Every day
            </h2>
            <p className={styles.muted}>By time of day, regardless of training</p>
          </div>
          <span className={styles.muted}>{plural(view.daily.count)}</span>
        </header>
        <ColumnHeader />
        {view.daily.slots
          .filter((s) => s.rows.length > 0)
          .map(({ slot, rows }) => (
            <div key={slot}>
              <h3 className={styles.slotHeading}>{SLOT_LABEL[slot]}</h3>
              <ul className={styles.list}>
                {rows.map((r) => (
                  <Row key={r.key} row={r} onOpen={open} edit={controls(r)} />
                ))}
              </ul>
            </div>
          ))}
        <button type="button" className={styles.addLink} onClick={(e) => openForm({ kind: 'add', preset: 'daily' }, e.currentTarget)}>
          + Add daily item
        </button>
      </section>

      {view.unscheduled.length > 0 && (
        <section className={styles.card} aria-labelledby="supp-unscheduled">
          <header className={styles.cardHeader}>
            <div>
              <h2 id="supp-unscheduled" className={styles.cardTitle}>
                Not scheduled
              </h2>
              <p className={styles.muted}>Active, but no dose applies on any day yet</p>
            </div>
            <span className={styles.muted}>{plural(view.unscheduled.length)}</span>
          </header>
          <ColumnHeader />
          <ul className={styles.list}>
            {view.unscheduled.map((r) => (
              <Row key={r.key} row={r} onOpen={open} edit={controls(r)} />
            ))}
          </ul>
        </section>
      )}

      <section className={styles.card} aria-label="Pending">
        {view.pending.length > 0 && (
          <button
            type="button"
            className={styles.pendingToggle}
            aria-expanded={pendingOpen || editing}
            // Edit stack mode keeps Pending open, so the toggle would do nothing.
            disabled={editing}
            onClick={() => setPendingOpen((o) => !o)}
          >
            <span aria-hidden="true">{pendingOpen || editing ? '▼' : '▶'}</span> Pending · {view.pending.length}
          </button>
        )}
        {(pendingOpen || editing) && view.pending.length > 0 && (
          <>
            <ColumnHeader />
            <ul className={styles.list}>
              {view.pending.map((r) => (
                <Row key={r.key} row={r} onOpen={open} edit={controls(r)} />
              ))}
            </ul>
          </>
        )}
        <button type="button" className={styles.addLink} onClick={(e) => openForm({ kind: 'add', preset: 'pending' }, e.currentTarget)}>
          + Add a pending item
        </button>
      </section>

      <p className={styles.muted}>Not medical advice.</p>

      {editing && (writeError || rowCount > 0) && (
        <div className={styles.bulkBar} role="region" aria-label="Selected items">
          <span>{selectedText}</span>
          {writeError && <span role="alert">{writeError}</span>}
          <span className={styles.bulkButtons}>
            {rowCount > 0 && (
              <>
                <button
                  type="button"
                  disabled={writing}
                  onClick={(e) => {
                    bulkOpener.current = e.currentTarget;
                    setDialog('move');
                  }}
                >
                  Move to…
                </button>
                <button
                  type="button"
                  disabled={writing}
                  onClick={(e) => {
                    bulkOpener.current = e.currentTarget;
                    setDialog('combine');
                  }}
                >
                  Combine into mix…
                </button>
                <button type="button" disabled={writing} onClick={() => void markAll('active')}>
                  Mark active
                </button>
                <button type="button" disabled={writing} onClick={() => void markAll('pending')}>
                  Mark pending
                </button>
                {/* Remove takes the whole item, every dose, so it counts items, not rows. */}
                <button
                  type="button"
                  className={styles.removeButton}
                  disabled={writing}
                  onClick={(e) => {
                    // The second click of a double-click isn't a second, deliberate tap.
                    if (e.detail > 1) return;
                    void removeAll();
                  }}
                >
                  {confirmRemove === removeKey ? `Tap again to remove ${plural(itemIds.length)}` : 'Remove'}
                </button>
              </>
            )}
            <button type="button" disabled={writing} onClick={clearSelection}>
              Clear
            </button>
          </span>
        </div>
      )}

      {dialog === 'move' && (
        <MoveDialog stack={stack} rows={selectedRows} onCancel={closeDialog} onDone={() => dialogDone(`Moved ${rowCount === 1 ? '1 row' : `${rowCount} rows`}.`)} />
      )}
      {dialog === 'combine' && (
        <CombineDialog rows={selectedRows} onCancel={closeDialog} onDone={() => dialogDone(`Combined ${plural(itemIds.length)} into a mix.`)} />
      )}

      {daysOpen && (
        <DayTypesDialog
          stack={daysStack}
          onCancel={() => {
            setDaysOpen(false);
            daysOpener.current?.focus();
          }}
          onDone={(saved) => {
            setDaysOpen(false);
            setSavedDays({ against: stack, settings: saved });
            // A day type that was removed can't stay selected.
            const ids = saved.dayTypes.map((d) => d.id);
            if (!ids.includes(view.dayType.id)) setDayTypeId(ids[0] ?? '');
            setAnnouncement('Saved day types.');
            daysOpener.current?.focus();
          }}
        />
      )}

      {openItem && (
        <SupplementDetail
          stack={stack}
          item={openItem}
          dayTypeId={view.dayType.id}
          notes={view.notesByItem.get(openItem.id) ?? []}
          onClose={() => {
            setOpenId(null);
            opener.current?.focus();
          }}
          onEdit={() => openForm({ kind: 'edit', item: openItem }, opener.current)}
          onReplace={() => openForm({ kind: 'replace', item: openItem }, opener.current)}
        />
      )}

      {form && (
        <SupplementForm
          stack={stack}
          mode={form}
          dayTypeId={view.dayType.id}
          onCancel={() => {
            setForm(null);
            // Cancel returns to the detail panel when the form came from one; from Edit stack mode there's none, so back to the row.
            if (!openItem) formOpener.current?.focus();
          }}
          onDismiss={(done) => {
            setForm(null);
            setOpenId(null);
            if (done) setAnnouncement(done);
            // The add button, or for an edit the row whose panel it came from. A replace moves or
            // removes that row, so focus goes to the Edit stack toggle, which stays.
            (form.kind === 'replace' ? modeToggle.current : formOpener.current)?.focus();
          }}
        />
      )}
    </div>
  );
}
