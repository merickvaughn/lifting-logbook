'use client';

import { useRef, useState } from 'react';
import { SLOT_LABEL, buildView, type RowModel, type Stack } from '@/lib/supplementsView';
import SupplementDetail from './SupplementDetail';
import styles from './supplements.module.css';

function Row({ row, onOpen }: { row: RowModel; onOpen: (row: RowModel, opener: HTMLElement) => void }) {
  const flagged = row.advisories.length > 0;
  return (
    <li className={flagged ? `${styles.row} ${styles.flagged}` : styles.row}>
      <button type="button" className={styles.rowButton} onClick={(e) => onOpen(row, e.currentTarget)}>
        <span className={styles.rowMain}>
          <span className={styles.line1}>
            <span className={styles.name}>
              {row.item.name}
              {row.also.length > 0 && <span className={styles.pill}>also {row.also.join(', ').toLowerCase()}</span>}
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
        <span aria-hidden="true" className={styles.chevron}>
          ›
        </span>
      </button>
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

/** The read-only Supplements page: day-type switcher, protein total, the Workout and Every day cards, Pending, and the detail panel. */
export default function SupplementsView({ stack }: { stack: Stack }) {
  const [dayTypeId, setDayTypeId] = useState(stack.dayTypes[0]?.id ?? '');
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  if (stack.dayTypes.length === 0) {
    return <p role="status">No day types are set up yet.</p>;
  }
  const view = buildView(stack, dayTypeId);
  const open = (row: RowModel, el: HTMLElement) => {
    opener.current = el;
    setOpenId(row.item.id);
  };
  const openItem = stack.items.find((i) => i.id === openId);
  const noWorkout = !view.dayType.sessionTime && view.workout.count === 0;
  const flagged = view.flaggedCount;

  return (
    <div>
      <p className={styles.subtitle}>
        {view.activeCount} active · {flagged} item{flagged === 1 ? ' has' : 's have'} a note worth a look · tap any item for details
      </p>

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
              Workout · {view.dayType.name}
            </h2>
            <p className={styles.muted}>{view.workout.sessionLine}</p>
          </div>
          <span className={styles.muted}>{plural(view.workout.count)}</span>
        </header>
        {noWorkout ? (
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
                      <Row key={r.key} row={r} onOpen={open} />
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </>
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
                  <Row key={r.key} row={r} onOpen={open} />
                ))}
              </ul>
            </div>
          ))}
      </section>

      {view.pending.length > 0 && (
        <section className={styles.card} aria-label="Pending">
          <button
            type="button"
            className={styles.pendingToggle}
            aria-expanded={pendingOpen}
            onClick={() => setPendingOpen((o) => !o)}
          >
            <span aria-hidden="true">{pendingOpen ? '▼' : '▶'}</span> Pending · {view.pending.length}
          </button>
          {pendingOpen && (
            <>
              <ColumnHeader />
              <ul className={styles.list}>
                {view.pending.map((r) => (
                  <Row key={r.key} row={r} onOpen={open} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <p className={styles.muted}>Not medical advice.</p>

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
        />
      )}
    </div>
  );
}
