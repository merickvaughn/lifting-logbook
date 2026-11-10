import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { isSameLift } from '@lifting-logbook/core';
import { fetchLiftMetadata, fetchWorkout } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import LiftEditor from '@/components/LiftEditor';
import { movedWorkoutPath } from '@/lib/macrocycleUrl';

export default async function EditLiftPage({
  params,
}: {
  params: Promise<{ macrocycleNum: string; workoutNum: string; lift: string }>;
}) {
  const { macrocycleNum: macrocycleNumParam, workoutNum: workoutNumParam, lift: liftParam } = await params;
  const macrocycleNum = Number(macrocycleNumParam);
  const workoutNum = Number(workoutNumParam);

  if (!Number.isInteger(macrocycleNum) || !Number.isInteger(workoutNum) || workoutNum < 1) {
    notFound();
  }

  const lift = decodeURIComponent(liftParam);

  // The metadata API answers for any lift name, so it can't say a lift is unknown (#1190).
  // A lift is editable here when this workout plans it, which is where Manage Lifts links
  // from. fetchWorkout returns null only for a 404; any other failure throws to the error
  // boundary, as does a failed metadata fetch.
  const program = await getActiveProgram();
  const workout = await fetchWorkout(program, workoutNum);
  if (!workout || !workout.lifts.some((planned) => isSameLift(planned.lift, lift))) {
    notFound();
  }
  const moved = movedWorkoutPath(
    `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts/edit/${liftParam}`,
    macrocycleNum,
    workout.macrocycleNum,
  );
  if (moved) redirect(moved);

  const metadata = await fetchLiftMetadata(lift);

  return (
    <main style={{ maxWidth: '600px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      <Link
        href={`/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts`}
        style={{ fontSize: '0.875rem', color: 'var(--color-primary, #0070f3)', textDecoration: 'none' }}
      >
        ← Back to Manage Lifts
      </Link>

      <h1 style={{ marginTop: '1rem', marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 600 }}>
        Edit Lift: {lift}
      </h1>

      <LiftEditor
        macrocycleNum={macrocycleNum}
        workoutNum={workoutNum}
        initialMetadata={metadata}
      />
    </main>
  );
}
