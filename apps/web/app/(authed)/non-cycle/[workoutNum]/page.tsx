import { notFound } from 'next/navigation';
import { fetchLiftCatalog, fetchNonCycleWorkout } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import NonCycleWorkout from '../NonCycleWorkout';

/** One non-cycle workout (#1184): add sets, edit them, or delete it. */
export default async function NonCycleWorkoutPage({ params }: { params: Promise<{ workoutNum: string }> }) {
  const workoutNum = Number((await params).workoutNum);
  if (!Number.isInteger(workoutNum) || workoutNum < 1) notFound();
  const program = await getActiveProgram();
  const [workout, catalog, unit] = await Promise.all([
    fetchNonCycleWorkout(workoutNum),
    // Suggestions only: any lift name can be typed, so the page works without them.
    // fallback-covered-by: apps/web/app/(authed)/non-cycle/page.test.tsx
    fetchLiftCatalog(program).catch((): string[] => []),
    getPreferredUnit(),
  ]);
  if (!workout) notFound();
  return <NonCycleWorkout program={program} catalog={catalog} unit={unit} workout={workout} />;
}
