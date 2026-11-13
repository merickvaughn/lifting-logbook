import {
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchTrainingMaxHistory,
} from '@/lib/api';
import { DEFAULT_WEIGHT_INCREMENT } from '@lifting-logbook/types';
import { getActiveProgram, getUserSettings } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import RepMaxCalculator from '@/components/RepMaxCalculator';
import TrainingMaxesForm from './TrainingMaxesForm';
import MissingTrainingMaxes from './MissingTrainingMaxes';
import { resolveStepIncrements } from './increments';
import MaxHistory from './MaxHistory';

export default async function TrainingMaxesPage() {
  const program = await getActiveProgram();
  const [maxes, history, specs, settings, unit] = await Promise.all([
    fetchTrainingMaxes(program),
    fetchTrainingMaxHistory(program),
    fetchProgramSpec(program),
    getUserSettings(),
    getPreferredUnit(),
  ]);
  const lifts = maxes.map((m) => m.lift);
  const defaultIncrement =
    settings.defaultWeightIncrement ?? DEFAULT_WEIGHT_INCREMENT;
  const increments = resolveStepIncrements(lifts, specs, defaultIncrement);

  return (
    <>
      <MissingTrainingMaxes program={program} preferredUnit={unit} step={defaultIncrement} />
      <TrainingMaxesForm
        program={program}
        lifts={lifts}
        maxes={maxes}
        increments={increments}
        unit={unit}
      />
      <MaxHistory initialEntries={history.entries} program={program} unit={unit} />
      <RepMaxCalculator unit={unit} />
    </>
  );
}
