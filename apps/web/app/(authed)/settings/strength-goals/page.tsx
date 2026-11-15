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
    fetchCustomLifts(),
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
