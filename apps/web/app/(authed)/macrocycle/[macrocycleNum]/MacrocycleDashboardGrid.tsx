'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatWeight } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import GlossaryLink from '@/components/GlossaryLink';
import { computeMacrocycleProgress, type WeekRow, type WorkoutCell } from '@/lib/workoutPlan';
import styles from './MacrocycleDashboardGrid.module.css';

/**
 * Groups week rows into mesocycles ("blocks") of `mesocycleWeeks` weeks — 5/3/1's
 * four 3-week blocks. Returns null when there is nothing to group: one-week blocks
 * (Leangains, RPT) or a program that is a single block, where a lone "Block 1"
 * header would only add noise.
 */
export function groupWeeksIntoBlocks(
  weeks: WeekRow[],
  mesocycleWeeks: number,
): { block: number; firstWeek: number; lastWeek: number; rows: WeekRow[] }[] | null {
  if (mesocycleWeeks <= 1) return null;
  const blocks = new Map<number, { firstWeek: number; lastWeek: number; rows: WeekRow[] }>();
  for (const row of weeks) {
    const block = Math.ceil(row.week / mesocycleWeeks);
    const group = blocks.get(block);
    if (group) {
      group.rows.push(row);
      group.lastWeek = row.week;
    } else {
      blocks.set(block, { firstWeek: row.week, lastWeek: row.week, rows: [row] });
    }
  }
  if (blocks.size <= 1) return null;
  return [...blocks.entries()].map(([block, group]) => ({ block, ...group }));
}

function findCurrentWeek(weeks: WeekRow[]): number {
  for (const row of weeks) {
    if (row.workouts.some((w) => w.status === 'upcoming')) {
      return row.week;
    }
  }
  return weeks[weeks.length - 1]?.week ?? 1;
}

const STATUS_LABELS: Record<WorkoutCell['status'], string> = {
  completed: 'Completed',
  upcoming: 'Upcoming',
  missed: 'Missed',
  skipped: 'Skipped',
};

function StatusBadge({ status }: { status: WorkoutCell['status'] }) {
  return (
    <span className={`${styles.badge} ${styles[`badge_${status}`]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function WorkoutCard({
  cell,
  macrocycleNum,
  unit,
}: {
  cell: WorkoutCell;
  macrocycleNum: number;
  unit: WeightUnit;
}) {
  return (
    <Link
      href={`/macrocycle/${macrocycleNum}/workout/${cell.workoutNum}/detail`}
      className={`${styles.workoutCard} ${styles[`card_${cell.status}`]}`}
    >
      <div className={styles.cardHeader}>
        <time dateTime={cell.date}>{cell.date}</time>
        <StatusBadge status={cell.status} />
      </div>
      <ul className={styles.liftList}>
        {cell.lifts.map((lift) => (
          <li key={lift.name} className={styles.liftItem}>
            <strong>{lift.name}</strong>
            <ol className={styles.setList}>
              {lift.sets.map((s) => (
                <li key={s.setLabel}>
                  {s.setLabel}: {formatWeight(s.weight, 'lbs', unit)} × {s.reps}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </Link>
  );
}

export default function MacrocycleDashboardGrid({
  macrocycleNum,
  weeks,
  unit,
  mesocycleWeeks = 1,
}: {
  macrocycleNum: number;
  weeks: WeekRow[];
  unit: WeightUnit;
  /** Weeks per mesocycle; when > 1 the weeks are grouped under block headers. */
  mesocycleWeeks?: number;
}) {
  const currentWeek = findCurrentWeek(weeks);

  const [expanded, setExpanded] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    for (const row of weeks) {
      initial[row.week] = row.week === currentWeek;
    }
    return initial;
  });

  const progress = computeMacrocycleProgress(weeks);
  const blocks = groupWeeksIntoBlocks(weeks, mesocycleWeeks);

  const renderWeek = (row: WeekRow) => {
    const isExpanded = expanded[row.week] ?? row.week === currentWeek;
    return (
      <div key={row.week} className={styles.weekSection}>
        <button
          type="button"
          className={styles.weekToggle}
          onClick={() =>
            setExpanded((prev) => ({
              ...prev,
              [row.week]: !prev[row.week],
            }))
          }
          aria-expanded={isExpanded}
        >
          <span>Week {row.week}</span>
          <span className={styles.toggleIcon} aria-hidden="true">
            {isExpanded ? '▲' : '▼'}
          </span>
        </button>
        {isExpanded && (
          <div className={styles.workouts}>
            {row.workouts.map((cell) => (
              <WorkoutCard key={cell.workoutNum} cell={cell} macrocycleNum={macrocycleNum} unit={unit} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className={styles.container}>
      <p className={styles.eyebrow}>Dashboard</p>
      <div className={styles.headingRow}>
        <h1 className={styles.heading}>Macrocycle {macrocycleNum}</h1>
        <GlossaryLink id="macrocycle" />
      </div>
      {progress.totalWorkouts > 0 && (
        <div className={styles.progressSection}>
          <div className={styles.progressHeader}>
            <span className={styles.progressLabel}>Macrocycle progress</span>
            <span className={styles.progressCount}>
              {progress.completedWorkouts} of {progress.totalWorkouts} workouts
            </span>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label="Macrocycle progress"
            aria-valuenow={progress.completedWorkouts}
            aria-valuemin={0}
            aria-valuemax={progress.totalWorkouts}
          >
            <div
              className={`${styles.progressFill} ${
                progress.completedWorkouts === progress.totalWorkouts
                  ? styles.progressFill_complete
                  : ''
              }`}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}
      <nav className={styles.quickNav}>
        <Link href={`/macrocycle/${macrocycleNum}/program`}>📋 Current Program</Link>
        <Link href={`/macrocycle/${macrocycleNum}/plan`}>🗓 Macrocycle Plan</Link>
        <Link href="/settings/training-maxes">💪 Training Maxes</Link>
        <Link href="/settings/strength-goals">🎯 Strength Goals</Link>
        <Link href="/history">📚 Lift History</Link>
        <Link href="/programs">🗂 Program Catalog</Link>
      </nav>
      <div className={styles.grid}>
        {blocks
          ? blocks.map(({ block, firstWeek, lastWeek, rows }) => (
              <section
                key={block}
                aria-labelledby={`block-${block}-heading`}
                className={styles.blockGroup}
              >
                <div className={styles.blockHeadingRow}>
                  <h2 id={`block-${block}-heading`} className={styles.blockHeading}>
                    Block {block} · Weeks {firstWeek}–{lastWeek}
                  </h2>
                  <GlossaryLink id="mesocycle" />
                </div>
                {rows.map(renderWeek)}
              </section>
            ))
          : weeks.map(renderWeek)}
      </div>
    </section>
  );
}
