import {
  fetchCustomLifts,
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

export default async function TrainingMaxesPage() {
  const program = await getActiveProgram();
  let importsFailed = false;
  const [maxes, history, specs, settings, unit, imports, customLifts] = await Promise.all([
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
    // Custom lifts only name a custom lift's row, so the page still renders, with stored ids for
    // those names, when they can't be read (#1291).
    // fallback-covered-by: apps/web/app/(authed)/settings/training-maxes/page.test.tsx
    fetchCustomLifts().catch((err: unknown) => {
      console.error('[TrainingMaxesPage] custom lifts fetch failed, showing custom lifts by id', err);
      return [];
    }),
  ]);
  const lifts = maxes.map((m) => m.lift);
  const defaultIncrement =
    settings.defaultWeightIncrement ?? DEFAULT_WEIGHT_INCREMENT;
  const increments = resolveStepIncrements(lifts, specs, defaultIncrement);
  // The components below copy the maxes into their own state, so a refresh alone leaves them
  // showing the old values. An undo removes its import from the list, so keying them on the list
  // remounts them with the restored maxes; otherwise the form's next Save would write the undone
  // values back (#1405). A refresh that only adds a max keeps the form's unsaved edits. Each key
  // is prefixed, since siblings sharing a key leave the old copy on the page.
  const importsKey = imports.map((b) => b.id).join(',');

  return (
    <>
      <MissingTrainingMaxes key={`missing:${importsKey}`} program={program} preferredUnit={unit} step={defaultIncrement} />
      <TrainingMaxesForm
        key={`form:${importsKey}`}
        program={program}
        lifts={lifts}
        maxes={maxes}
        customLifts={customLifts}
        increments={increments}
        unit={unit}
      />
      <TrainingMaxImports imports={imports} failed={importsFailed} />
      <MaxHistory key={`history:${importsKey}`} initialEntries={history.entries} program={program} unit={unit} />
      <RepMaxCalculator unit={unit} />
    </>
  );
}
