import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { buildMuscleTargetResolver, complexIdOf, defaultMuscleTargetsFor, isSameLift } from '@lifting-logbook/core';
import type { LiftMetadataResponse } from '@lifting-logbook/types';
import { fetchAllLiftMetadata, fetchWorkout } from '@/lib/api';
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
  //
  // The metadata is read from the whole list rather than the single-lift GET (#1017): before
  // #1017 this page saved a multi-word lift under its URL-encoded name ("Bench%20Press"). Read
  // through the list, such a row fills the editor until the real name has a row of its own, so
  // saving carries its values forward, and the API then retires it.
  const program = await getActiveProgram();
  const workout = await fetchWorkout(program, workoutNum);
  // A complex slot (#1495) has no lift metadata of its own.
  if (complexIdOf(lift) !== undefined || !workout || !workout.lifts.some((planned) => isSameLift(planned.lift, lift))) {
    notFound();
  }
  const moved = movedWorkoutPath(
    `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts/edit/${liftParam}`,
    macrocycleNum,
    workout.macrocycleNum,
  );
  if (moved) redirect(moved);

  // The legacy row is the one stored under exactly the name the old editor saved, the same row
  // the API retires on save.
  const rows = await fetchAllLiftMetadata();
  const encoded = encodeURIComponent(lift);
  const row =
    rows.find((meta) => meta.lift === lift) ?? (encoded === lift ? undefined : rows.find((meta) => meta.lift === encoded));
  const metadata: LiftMetadataResponse = row ? { ...row, lift } : emptyMetadata(lift);
  // Resolved from the row the form is filled from, so the muscles shown are the ones a save
  // writes. Resolved here, since the resolver is a closure and can't cross to the client.
  const muscles = buildMuscleTargetResolver(row ? [metadata] : [])(lift);
  const defaultMuscles = defaultMuscleTargetsFor(lift) ?? null;

  return (
    <main style={{ maxWidth: '600px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      <Link
        href={`/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts`}
        style={{ fontSize: '0.875rem', color: 'var(--color-accent)', textDecoration: 'none' }}
      >
        ← Back to Manage Lifts
      </Link>

      <h1 style={{ marginTop: '1rem', marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 600 }}>
        Edit Lift: {lift}
      </h1>

      <LiftEditor
        program={program}
        macrocycleNum={macrocycleNum}
        workoutNum={workoutNum}
        initialMetadata={metadata}
        muscles={muscles}
        defaultMuscles={defaultMuscles}
      />
    </main>
  );
}

function emptyMetadata(lift: string): LiftMetadataResponse {
  return {
    lift,
    muscleGroups: [],
    secondaryMuscleGroups: [],
    substitutions: [],
    foundational: false,
    progression: null,
    progressionIncrement: null,
    repsLow: null,
    repsHigh: null,
  };
}
