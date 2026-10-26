'use client';

import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { formatWeight } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import { plannedRowIds } from '@/lib/focusWorkout';
import type { PlannedSet, WorkoutLiftDetail } from '@/lib/workoutPlan';
import { useTimerRowState } from '@/components/timer/WorkoutTimerProvider';
import type { TimerRowState } from '@/components/timer/WorkoutTimerProvider';
import styles from './detail.module.css';

/**
 * What the list renders per lift — the shape `loadWorkoutPlan` builds once for
 * this page and the timer route, with the activation movement already narrowed.
 */
export type LiftDetail = WorkoutLiftDetail;

/** A planned lift, by its position in `liftDetails` — the timer's identity for it. */
export interface PlannedLiftRow {
  kind: 'planned';
  id: string;
  liftIndex: number;
}

/**
 * A focus lift (#1058), already worded by the caller. Rendered with the planned
 * row's header and panel, but with no timer controls and no history link: the
 * timer does not queue focus lifts yet (#1060).
 */
export interface FocusLiftRow {
  kind: 'focus';
  id: string;
  lift: string;
  /** Collapsed summary, e.g. "3 × 10–12". */
  summary: string;
  /** E.g. "Focus sets · Double progression". */
  groupLabel: string;
  sets: number;
  /** Each set's spec, e.g. "10–12 reps @ 25 lbs". */
  perSet: string;
  hint: string;
  /** The reduced or swapped note, shown under the header. */
  note: string | null;
  /** Shown as a tag when focus lifts are mixed in with planned ones. */
  area: string | null;
}

export type LiftListRow = PlannedLiftRow | FocusLiftRow;

/** Lets the lifter reorder rows: drag by the grip, or the ↑ ↓ buttons. */
export interface LiftListReorder {
  onMove: (from: number, to: number) => void;
}

interface Props {
  liftDetails: LiftDetail[];
  macrocycleNum: number;
  workoutNum: number;
  unit: WeightUnit;
  /** What to render, in order. Defaults to every planned lift in plan order. */
  rows?: LiftListRow[];
  reorder?: LiftListReorder;
}

/**
 * One planned set.
 *
 * Gains a ▶ and active/done styling only inside a `WorkoutTimerProvider`, and
 * only for sets the timer actually queues — a warm-up is not startable while
 * "skip warm-up timers" is on, so it keeps the plain presentation rather than
 * offering a control that would jump somewhere else.
 */
function SetRow({
  lift,
  liftIndex,
  set,
  unit,
  timer,
}: {
  lift: string;
  /** Position of the lift in the plan — the timer's identity for it, not the name. */
  liftIndex: number;
  set: PlannedSet;
  unit: WeightUnit;
  timer: TimerRowState | null;
}) {
  const spec = `${set.reps} × ${formatWeight(set.weight, 'lbs', unit)}`;
  const setIndex = timer === null ? null : timer.setIndexOf(liftIndex, set.setLabel);

  const isActive = timer != null && setIndex != null && timer.activeSetIndex === setIndex;
  const isDone = timer != null && setIndex != null && setIndex <= timer.doneThroughIndex;

  const className = [
    styles.setRow,
    isActive ? styles.setRowActive : '',
    isDone ? styles.setRowDone : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <span className={styles.setLabel}>{set.setLabel}</span>
      <span className={styles.setSpec}>{spec}</span>
      {timer != null && setIndex != null && (
        <button
          type="button"
          className={`${styles.setPlay} focus-ring`}
          aria-label={`Start timer at ${lift} ${set.setLabel}`}
          onClick={() => timer.startAtSet(setIndex)}
        >
          <span aria-hidden="true">▶</span>
        </button>
      )}
    </div>
  );
}

function PlannedPanel({
  detail,
  liftIndex,
  unit,
  timer,
}: {
  detail: LiftDetail;
  liftIndex: number;
  unit: WeightUnit;
  timer: TimerRowState | null;
}) {
  const { lift, activationMovement: movement, plannedSets } = detail;
  const warmUpSets = plannedSets.filter((s) => s.type === 'warmup');
  const workSets = plannedSets.filter((s) => s.type === 'work');
  // Gated on `plannedSets`: with no training max there is nothing to time,
  // so the queue emits no activation for such a lift (its plan entry is
  // kept, empty, to hold its position). Ungated, the block rendered
  // directly above "No sets — set a training max…", promising a countdown
  // that could not happen.
  const activationMovement = plannedSets.length > 0 ? movement : undefined;

  return (
    <>
      {activationMovement !== undefined && (
        /*
          Read-only: an activation is not a set, so it gets no ▶ — the
          timer reaches it by starting the session, not by starting a
          set. Shown here so the phase the timer counts down has a
          visible home in the plan.
        */
        <div className={styles.setGroup}>
          <span className={styles.setGroupLabel}>Activation</span>
          <div className={styles.setRow}>
            <span className={styles.setLabel}>{activationMovement}</span>
          </div>
        </div>
      )}

      {warmUpSets.length > 0 && (
        <div className={styles.setGroup}>
          <span className={styles.setGroupLabel}>Warm-up</span>
          {warmUpSets.map((s) => (
            <SetRow key={s.setLabel} lift={lift} liftIndex={liftIndex} set={s} unit={unit} timer={timer} />
          ))}
        </div>
      )}

      {workSets.length > 0 && (
        <div className={styles.setGroup}>
          <span className={styles.setGroupLabel}>Working Sets</span>
          {workSets.map((s) => (
            <SetRow key={s.setLabel} lift={lift} liftIndex={liftIndex} set={s} unit={unit} timer={timer} />
          ))}
        </div>
      )}

      {plannedSets.length === 0 && (
        <p className={styles.noSets}>No sets — set a training max to see planned weights.</p>
      )}
    </>
  );
}

function FocusPanel({ row }: { row: FocusLiftRow }) {
  return (
    <>
      <div className={styles.setGroup}>
        <span className={styles.setGroupLabel}>{row.groupLabel}</span>
        {Array.from({ length: row.sets }, (_, k) => (
          <div key={k} className={styles.setRow}>
            <span className={styles.setLabel}>Set {k + 1}</span>
            <span className={styles.setSpec}>{row.perSet}</span>
          </div>
        ))}
      </div>
      <p className={styles.liftHint}>{row.hint}</p>
    </>
  );
}

export default function CollapsibleLiftList({
  liftDetails,
  macrocycleNum,
  workoutNum,
  unit,
  rows,
  reorder,
}: Props) {
  const list: LiftListRow[] =
    rows ??
    plannedRowIds(liftDetails.map((d) => d.lift)).map((id, liftIndex) => ({ kind: 'planned', id, liftIndex }));
  // Keyed by row id, not lift name: the same lift can appear twice in one
  // workout, so ids count occurrences, and a planned row also carries its
  // position, which is the identity the timer uses for it (issue #971).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  // After an arrow move: which row and arrow to keep focus on, and what to announce.
  const [moved, setMoved] = useState<{ id: string; direction: 'up' | 'down'; message: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Per-instance prefix for the panel ids: a bare positional id would collide
  // the moment a second list rendered on the page and silently break the
  // header's `aria-controls` target.
  const idBase = useId();
  // Null outside a WorkoutTimerProvider — the list renders exactly as it did
  // before the timer existed, which is also how its own tests mount it.
  const timer = useTimerRowState();
  const activeLiftIndex = timer === null ? null : timer.activeLiftIndex;
  const activeRowId =
    activeLiftIndex === null ? undefined
    : list.find((row) => row.kind === 'planned' && row.liftIndex === activeLiftIndex)?.id;

  // Reveal the lift the timer just moved to, so the current set is visible
  // without hunting for it. Added to the same set the header toggles, so the
  // lifter can still collapse it afterwards.
  useEffect(() => {
    if (activeRowId === undefined) return;
    setExpanded((prev) => (prev.has(activeRowId) ? prev : new Set(prev).add(activeRowId)));
  }, [activeRowId]);

  // A row moved by its arrow re-renders at its new position. When the arrow
  // just pressed is now disabled (the row reached an end), focus would fall to
  // <body>, so it goes to the row's other arrow instead.
  useEffect(() => {
    if (moved === null || listRef.current === null) return;
    const item = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-row-id]')).find(
      (el) => el.dataset.rowId === moved.id,
    );
    const pressed = item?.querySelector<HTMLButtonElement>(`[data-move="${moved.direction}"]`);
    const other = item?.querySelector<HTMLButtonElement>(`[data-move="${moved.direction === 'up' ? 'down' : 'up'}"]`);
    (pressed && !pressed.disabled ? pressed : other)?.focus();
  }, [moved]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function moveByArrow(onMove: LiftListReorder['onMove'], row: LiftListRow, lift: string, from: number, to: number) {
    onMove(from, to);
    setMoved({
      id: row.id,
      direction: to < from ? 'up' : 'down',
      message: `${lift} moved to position ${to + 1} of ${list.length}`,
    });
  }

  return (
    <>
    <ul className={styles.liftList} ref={listRef}>
      {list.map((row, position) => {
        let lift: string;
        let label: ReactNode;
        let summary: string;
        let panel: ReactNode;
        if (row.kind === 'planned') {
          const detail = liftDetails[row.liftIndex];
          if (detail === undefined) return null;
          lift = detail.lift;
          label = detail.tm > 0 ? <span className={styles.liftTM}>TM: {formatWeight(detail.tm, 'lbs', unit)}</span> : null;
          summary = `${detail.warmUpCount > 0 ? `${detail.warmUpCount} warm-up • ` : ''}${detail.workCount} working`;
          panel = <PlannedPanel detail={detail} liftIndex={row.liftIndex} unit={unit} timer={timer} />;
        } else {
          lift = row.lift;
          label =
            row.area !== null ?
              <span className={styles.areaTag} data-area={row.area}>
                {row.area}
              </span>
            : null;
          summary = row.summary;
          panel = <FocusPanel row={row} />;
        }
        const isExpanded = expanded.has(row.id);
        const panelId = `${idBase}-lift-${position}`;

        // Only the grip starts a drag, so a drag from the header, a History
        // link or selected text can't reorder anything. The whole row is the
        // drop target. `setData` is what lets the drag start in Firefox.
        const dropProps =
          reorder ?
            {
              onDragOver: (e: DragEvent) => e.preventDefault(),
              onDrop: (e: DragEvent) => {
                e.preventDefault();
                const draggedId = dragging ?? e.dataTransfer.getData('text/plain');
                const from = list.findIndex((r) => r.id === draggedId);
                if (from >= 0 && from !== position) reorder.onMove(from, position);
                setDragging(null);
              },
            }
          : {};

        return (
          <li
            key={row.id}
            className={`${styles.liftItem} ${dragging === row.id ? styles.liftItemDragging : ''}`}
            data-row-id={row.id}
            {...dropProps}
          >
            <div className={styles.liftItemRow}>
              {reorder && (
                <span
                  className={styles.grip}
                  aria-hidden="true"
                  title="Drag to reorder"
                  draggable
                  onDragStart={(e) => {
                    setDragging(row.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', row.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  ⠿
                </span>
              )}
              <button
                type="button"
                className={styles.liftItemHeader}
                onClick={() => toggle(row.id)}
                aria-expanded={isExpanded}
                aria-controls={panelId}
              >
                <span
                  className={`${styles.liftToggleIcon} ${isExpanded ? styles.liftToggleIconExpanded : ''}`}
                  aria-hidden="true"
                >
                  ›
                </span>

                <span className={styles.liftName}>
                  {lift}
                  {label}
                </span>

                <span className={styles.liftSummary}>{summary}</span>
              </button>

              {row.kind === 'planned' && (
                <Link
                  href={`/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/${encodeURIComponent(lift)}`}
                  className={styles.liftHistoryBtn}
                >
                  📊 History
                </Link>
              )}

              {reorder && (
                <span className={styles.moveBtns}>
                  <button
                    type="button"
                    className={`${styles.moveBtn} focus-ring`}
                    aria-label={`Move ${lift} up`}
                    data-move="up"
                    disabled={position === 0}
                    onClick={() => moveByArrow(reorder.onMove, row, lift, position, position - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={`${styles.moveBtn} focus-ring`}
                    aria-label={`Move ${lift} down`}
                    data-move="down"
                    disabled={position === list.length - 1}
                    onClick={() => moveByArrow(reorder.onMove, row, lift, position, position + 1)}
                  >
                    ↓
                  </button>
                </span>
              )}
            </div>

            {row.kind === 'focus' && row.note !== null && <p className={styles.liftNote}>{row.note}</p>}

            <div
              id={panelId}
              className={`${styles.liftItemContent} ${isExpanded ? styles.liftItemContentVisible : ''}`}
            >
              <div className={styles.liftItemContentInner}>{panel}</div>
            </div>
          </li>
        );
      })}
    </ul>
    {reorder && (
      <p className={styles.srOnly} aria-live="polite">
        {moved?.message ?? ''}
      </p>
    )}
    </>
  );
}
