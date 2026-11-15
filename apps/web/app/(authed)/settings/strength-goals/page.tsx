import { fetchCustomLifts, fetchLatestBodyWeight, fetchStrengthGoals, fetchTrainingMaxes } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import StrengthGoalsForm from './StrengthGoalsForm';

export default async function StrengthGoalsPage() {
  const program = await getActiveProgram();
  const [maxes, goals, bodyWeight, preferredUnit, customLifts] = await Promise.all([
    fetchTrainingMaxes(program),
    fetchStrengthGoals(program),
    fetchLatestBodyWeight(program),
    getPreferredUnit(),
    // Custom lifts only name a custom lift's goal or card, so the page still renders, with
    // stored ids for those names, when they can't be read.
    // fallback-covered-by: apps/web/app/(authed)/settings/strength-goals/page.test.tsx
    fetchCustomLifts().catch((err: unknown) => {
      console.error('[StrengthGoalsPage] custom lifts fetch failed, showing custom lifts by id', err);
      return [];
    }),
  ]);

  return (
    <StrengthGoalsForm
      program={program}
      trainingMaxes={maxes}
      goals={goals}
      bodyWeight={bodyWeight}
      preferredUnit={preferredUnit}
      customLifts={customLifts}
    />
  );
}
