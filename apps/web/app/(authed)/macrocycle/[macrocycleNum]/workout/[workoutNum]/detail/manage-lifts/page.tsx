import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { fetchWorkout } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { movedWorkoutPath } from '@/lib/macrocycleUrl';
import ManageLiftsActions from './ManageLiftsActions';
import styles from './manage-lifts.module.css';

export default async function ManageLiftsPage({
  params,
}: {
  params: Promise<{ macrocycleNum: string; workoutNum: string }>;
}) {
  const { macrocycleNum: macrocycleNumParam, workoutNum: workoutNumParam } = await params;
  const macrocycleNum = Number(macrocycleNumParam);
  const workoutNum = Number(workoutNumParam);

  if (!Number.isInteger(macrocycleNum) || !Number.isInteger(workoutNum) || workoutNum < 1) {
    notFound();
  }

  const program = await getActiveProgram();
  const workout = await fetchWorkout(program, workoutNum);

  if (!workout) {
    notFound();
  }
  const moved = movedWorkoutPath(
    `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts`,
    macrocycleNum,
    workout.macrocycleNum,
  );
  if (moved) redirect(moved);

  return (
    <main className={styles.container}>
      <Link
        href={`/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail`}
        className={styles.backLink}
      >
        ← Back to Workout
      </Link>

      <header className={styles.header}>
        <h1 className={styles.title}>Manage Lifts</h1>
        <p className={styles.subtitle}>Week {workout.week} — Workout {workoutNum}</p>
      </header>

      <section className={styles.liftsSection}>
        <ManageLiftsActions
          program={program}
          macrocycleNum={macrocycleNum}
          macrocycleId={workout.macrocycleId}
          workoutNum={workoutNum}
          lifts={workout.lifts}
        />
      </section>

      <div className={styles.addLift}>
        <Link
          href={`/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts/pick?action=add`}
          className={styles.btnPrimary}
        >
          + Add Lift
        </Link>
      </div>
    </main>
  );
}
