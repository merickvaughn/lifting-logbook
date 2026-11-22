import {
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchTrainingMaxHistory,
  fetchTrainingMaxImportBatches,
} from '@/lib/api';
import { DEFAULT_WEIGHT_INCREMENT } from '@lifting-logbook/types';
import type { TrainingMaxImportBatchSummary } from '@lifting-logbook/types';
import { getActiveProgram, getUserSettings } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import RepMaxCalculator from '@/components/RepMaxCalculator';
import TrainingMaxesForm from './TrainingMaxesForm';
import MissingTrainingMaxes from './MissingTrainingMaxes';
import { resolveStepIncrements } from './increments';
import MaxHistory from './MaxHistory';
import TrainingMaxImports from './TrainingMaxImports';
import styles from './TrainingMaxImports.module.css';

export default async function TrainingMaxesPage() {
  const program = await getActiveProgram();
  let importsFailed = false;
  const [maxes, history, specs, settings, unit, imports] = await Promise.all([
    fetchTrainingMaxes(program),
    fetchTrainingMaxHistory(program),
    fetchProgramSpec(program),
    getUserSettings(),
    getPreferredUnit(),
    // The imports Undo is offered for (#1405). Without them the page is whole but shows no Undo,
    // so the notice says only that.
    // fallback-covered-by: apps/web/app/(authed)/settings/training-maxes/page.test.tsx
    fetchTrainingMaxImportBatches(program).catch((err: unknown): TrainingMaxImportBatchSummary[] => {
      console.error('[TrainingMaxesPage] training-max imports fetch failed, showing no Undo', err);
      importsFailed = true;
      return [];
    }),
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
      {importsFailed && (
        <p role="status" className={styles.error}>
          Undoing a training-max import isn’t available right now. Refresh the page in a moment to try again.
        </p>
      )}
      <TrainingMaxImports imports={imports} />
      <MaxHistory initialEntries={history.entries} program={program} unit={unit} />
      <RepMaxCalculator unit={unit} />
    </>
  );
}
