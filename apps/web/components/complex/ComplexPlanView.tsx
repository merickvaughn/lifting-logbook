'use client';

import { useRouter } from 'next/navigation';
import { formatWeight, liftIdFor } from '@lifting-logbook/core';
import type { WeightUnit } from '@lifting-logbook/types';
import { MissingMaxRow } from '@/components/missing-max/MissingMaxRow';
import type { ComplexPlan } from '@/lib/workoutPlan';
import styles from './ComplexPlanView.module.css';

/**
 * What a complex slot is (#1495): its lifts in order with their reps, and which lift's max its
 * weights come from. The planned sets themselves render as any lift's do.
 */
export function ComplexSummary({ complex, tm, unit }: { complex: ComplexPlan; tm: number; unit: WeightUnit }) {
  if (!complex.found) {
    return <p className={styles.note}>This complex was deleted or couldn’t be read, so nothing is planned for it.</p>;
  }
  return (
    <>
      <ol className={styles.components} aria-label={`${complex.name} lifts`}>
        {complex.components.map((c, i) => (
          <li key={i}>
            {c.name} × {c.reps}
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
 * saved max re-renders the page, which then plans the complex. The max is saved under the lift as
 * the complex stores it, where a custom lift's max lives (#1291). There is no **Don't ask again**:
 * it would silence the lift's own prompt everywhere while this complex still needs the max.
 */
export function ComplexMissingMaxes({ complex, program }: { complex: ComplexPlan; program: string }) {
  const router = useRouter();
  if (complex.missing.length === 0) return null;
  return (
    <>
      <p className={styles.note}>Set a training max for each of its lifts to plan this complex.</p>
      <ul className={styles.missing}>
        {complex.missing.map(({ lift, name }) => (
          <MissingMaxRow
            key={lift}
            entry={{ lift, name, liftId: liftIdFor(lift), estimate: null, dismissed: false }}
            program={program}
            source="workout"
            dismissible={false}
            onSetUp={() => router.refresh()}
          />
        ))}
      </ul>
    </>
  );
}
