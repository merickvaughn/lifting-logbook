'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { activationExercise, formatWeight } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import type { PlannedSet } from '@/lib/workoutPlan';
import { useTimerRowState } from '@/components/timer/WorkoutTimerProvider';
import type { TimerRowState } from '@/components/timer/WorkoutTimerProvider';
import styles from './detail.module.css';

export interface LiftDetail {
  lift: string;
  tm: number;
  /**
   * The program spec's raw `activation` column. Narrowed here with
   * `activationExercise`, because the column also carries legacy classification
   * values (`'compound'` / `'isolation'`) that are not movement names.
   */
  activation?: string | undefined;
  warmUpCount: number;
  workCount: number;
  plannedSets: PlannedSet[];
}

interface Props {
  liftDetails: LiftDetail[];
  cycleNum: number;
  workoutNum: number;
  unit: WeightUnit;
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

export default function CollapsibleLiftList({
  liftDetails,
  cycleNum,
  workoutNum,
  unit,
}: Props) {
  // Keyed by position, not lift name: the same lift can appear twice in one
  // workout, and position is the identity the timer uses for it (issue #971).
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Per-instance prefix for the panel ids: a bare positional id would collide
  // the moment a second list rendered on the page and silently break the
  // header's `aria-controls` target.
  const idBase = useId();
  // Null outside a WorkoutTimerProvider — the list renders exactly as it did
  // before the timer existed, which is also how its own tests mount it.
  const timer = useTimerRowState();
  const activeLiftIndex = timer === null ? null : timer.activeLiftIndex;

  // Reveal the lift the timer just moved to, so the current set is visible
  // without hunting for it. Added to the same set the header toggles, so the
  // lifter can still collapse it afterwards.
  useEffect(() => {
    if (activeLiftIndex === null) return;
    setExpanded((prev) =>
      prev.has(activeLiftIndex) ? prev : new Set(prev).add(activeLiftIndex),
    );
  }, [activeLiftIndex]);

  function toggle(liftIndex: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(liftIndex)) next.delete(liftIndex);
      else next.add(liftIndex);
      return next;
    });
  }

  return (
    <ul className={styles.liftList}>
      {liftDetails.map(({ lift, tm, activation, warmUpCount, workCount, plannedSets }, liftIndex) => {
        const isExpanded = expanded.has(liftIndex);
        const panelId = `${idBase}-lift-${liftIndex}`;
        const warmUpSets = plannedSets.filter((s) => s.type === 'warmup');
        const workSets = plannedSets.filter((s) => s.type === 'work');
        // Gated on `plannedSets`: with no training max there is nothing to time,
        // so the queue emits no activation for such a lift (its plan entry is
        // kept, empty, to hold its position). Ungated, the block rendered
        // directly above "No sets — set a training max…", promising a countdown
        // that could not happen.
        const activationMovement =
          plannedSets.length > 0 ? activationExercise(activation) : undefined;

        return (
          <li key={liftIndex} className={styles.liftItem}>
            <div className={styles.liftItemRow}>
              <button
                type="button"
                className={styles.liftItemHeader}
                onClick={() => toggle(liftIndex)}
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
                  {tm > 0 && (
                    <span className={styles.liftTM}>TM: {formatWeight(tm, 'lbs', unit)}</span>
                  )}
                </span>

                <span className={styles.liftSummary}>
                  {warmUpCount > 0 ? `${warmUpCount} warm-up • ` : ''}
                  {workCount} working
                </span>
              </button>

              <Link
                href={`/cycle/${cycleNum}/workout/${workoutNum}/detail/${encodeURIComponent(lift)}`}
                className={styles.liftHistoryBtn}
              >
                📊 History
              </Link>
            </div>

            <div
              id={panelId}
              className={`${styles.liftItemContent} ${isExpanded ? styles.liftItemContentVisible : ''}`}
            >
              <div className={styles.liftItemContentInner}>
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
                      <SetRow
                        key={s.setLabel}
                        lift={lift}
                        liftIndex={liftIndex}
                        set={s}
                        unit={unit}
                        timer={timer}
                      />
                    ))}
                  </div>
                )}

                {workSets.length > 0 && (
                  <div className={styles.setGroup}>
                    <span className={styles.setGroupLabel}>Working Sets</span>
                    {workSets.map((s) => (
                      <SetRow
                        key={s.setLabel}
                        lift={lift}
                        liftIndex={liftIndex}
                        set={s}
                        unit={unit}
                        timer={timer}
                      />
                    ))}
                  </div>
                )}

                {plannedSets.length === 0 && (
                  <p className={styles.noSets}>
                    No sets — set a training max to see planned weights.
                  </p>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
