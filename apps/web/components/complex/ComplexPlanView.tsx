'use client';

import { useRouter } from 'next/navigation';
import { formatWeight } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import { SkippedLiftRows } from '@/components/missing-max/MissingMaxRow';
import { UNKNOWN_COMPLEX, type ComplexPlan } from '@/lib/workoutPlan';
import styles from './ComplexPlanView.module.css';

/**
 * What a complex slot is (#1495): its lifts in order with their reps, and which lift's max its
 * weights come from. The planned sets themselves render as any lift's do.
 */
export function ComplexSummary({ complex, tm, unit }: { complex: ComplexPlan; tm: number; unit: WeightUnit }) {
  if (complex.name === UNKNOWN_COMPLEX) {
    return <p className={styles.note}>This complex was deleted or couldn’t be read, so nothing is planned for it.</p>;
  }
  return (
    <>
      <ol className={styles.components} aria-label={`${complex.name} lifts`}>
        {complex.components.map((c, i) => (
          <li key={i}>
            {c.lift} × {c.reps}
          </li>
        ))}
      </ol>
      {complex.limitingLift !== undefined && (
        <p className={styles.note}>
          Limited by {complex.limitingLift} ({formatWeight(tm, 'lbs', unit)} training max)
        </p>
      )}
    </>
  );
}

/**
 * The lifts keeping a complex unplanned, each with the offer to set its training max (#1246). A
 * saved max re-renders the page, which then plans the complex.
 */
export function ComplexMissingMaxes({ complex, program }: { complex: ComplexPlan; program: string }) {
  const router = useRouter();
  if (complex.missing.length === 0) return null;
  return (
    <>
      <p className={styles.note}>Set a training max for each of its lifts to plan this complex.</p>
      <SkippedLiftRows
        skipped={complex.missing.map((lift) => ({ lift, reason: 'no-training-max' as const }))}
        program={program}
        source="workout"
        onSetUp={() => router.refresh()}
      />
    </>
  );
}
