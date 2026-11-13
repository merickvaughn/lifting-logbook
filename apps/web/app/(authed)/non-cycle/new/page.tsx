import { fetchLiftCatalog } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import NonCycleWorkout from '../NonCycleWorkout';

/** Starts a non-cycle workout (#1184). Its first set creates it. */
export default async function NewNonCycleWorkoutPage() {
  const program = await getActiveProgram();
  const [catalog, unit] = await Promise.all([
    // Suggestions only: any lift name can be typed, so the page works without them.
    // fallback-covered-by: apps/web/app/(authed)/non-cycle/page.test.tsx
    fetchLiftCatalog(program).catch((): string[] => []),
    getPreferredUnit(),
  ]);
  return <NonCycleWorkout program={program} catalog={catalog} unit={unit} workout={null} />;
}
