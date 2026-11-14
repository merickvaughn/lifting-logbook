import Link from 'next/link';
import { storedIdListing } from '@lifting-logbook/core';
import {
  fetchImportBatches,
  fetchLiftRecords,
  fetchMacrocycles,
  fetchNonCycleRecords,
  fetchTrainingMaxHistory,
} from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import type {
  ImportBatchSummary,
  LiftRecordResponse,
  MacrocycleSummaryResponse,
  TrainingMaxHistoryEntryResponse,
  WeightUnit,
} from '@lifting-logbook/types';
import { buildTmAtTimeIndex } from '@/lib/tmAtTime';
import HistoryTabs from './HistoryTabs';
import styles from './history.module.css';

export type EnrichedRecord = LiftRecordResponse & {
  tmAtTime: number | null;
  tmUnit: WeightUnit | null;
  tmPercent: number | null;
  isPR: boolean;
};

export default async function HistoryPage() {
  const program = await getActiveProgram();

  // Wrap the API calls so a transient failure (expired session token, API
  // unavailable) surfaces a non-blocking notice rather than crashing the server
  // component or silently rendering an empty page that reads as "no history yet".
  // The `.catch()` fallbacks keep the tabs rendering (graceful degradation);
  // `loadFailed` distinguishes a real fetch failure from a genuinely empty history.
  let loadFailed = false;
  let importsFailed = false;
  const [programRecords, nonCycleRecords, { entries: tmEntries }, macrocycles, imports, unit] = await Promise.all([
    // fallback-covered-by: apps/web/e2e/staging.spec.ts
    fetchLiftRecords(program).catch((): LiftRecordResponse[] => {
      loadFailed = true;
      return [];
    }),
    // Non-cycle workouts (#1184) are listed whichever program is active.
    // fallback-covered-by: apps/web/app/(authed)/history/page.test.tsx
    fetchNonCycleRecords().catch((): LiftRecordResponse[] => {
      loadFailed = true;
      return [];
    }),
    // fallback-covered-by: apps/web/e2e/staging.spec.ts
    fetchTrainingMaxHistory(program).catch(() => {
      loadFailed = true;
      return { entries: [] as TrainingMaxHistoryEntryResponse[] };
    }),
    // fallback-covered-by: apps/web/app/(authed)/history/page.test.tsx
    fetchMacrocycles(program).catch((): MacrocycleSummaryResponse[] => {
      loadFailed = true;
      return [];
    }),
    // The imports Undo is offered for (#1257). Without them the history is whole but shows no
    // Undo, so the notice says only that.
    // fallback-covered-by: apps/web/app/(authed)/history/page.test.tsx
    fetchImportBatches(program).catch((): ImportBatchSummary[] => {
      importsFailed = true;
      return [];
    }),
    getPreferredUnit(),
  ]);

  const records = [...programRecords, ...nonCycleRecords];
  const sortedRecords = records.slice().sort((a, b) => b.date.localeCompare(a.date));

  // A record stored by catalog id shares its lift's PR with a record under the lift's name (#1135).
  const listing = storedIdListing(sortedRecords.map((r) => r.lift));
  const maxByLift = new Map<string, number>();
  for (const r of sortedRecords) {
    const lift = listing(r.lift);
    maxByLift.set(lift, Math.max(maxByLift.get(lift) ?? 0, r.weight));
  }

  // Walk oldest→newest; first record per lift that equals the max is the PR.
  const prRecordIds = new Set<string>();
  const prSeenLifts = new Set<string>();
  for (let i = sortedRecords.length - 1; i >= 0; i--) {
    const r = sortedRecords[i];
    const lift = listing(r.lift);
    if (!prSeenLifts.has(lift) && r.weight >= (maxByLift.get(lift) ?? 0)) {
      prRecordIds.add(r.id);
      prSeenLifts.add(lift);
    }
  }

  // Built once: the per-record lookup used to filter and sort the whole history
  // again for every record (issue #981).
  const tmAtTime = buildTmAtTimeIndex(tmEntries);
  const enriched: EnrichedRecord[] = sortedRecords.map((r) => {
    // A non-cycle set wasn't done against any program's max, so it shows none (decision 23).
    const tm = r.program === NON_CYCLE_PROGRAM ? null : tmAtTime.find(r.lift, r.date);
    const tmPercent =
      tm !== null ? Math.round((r.weight / tm.weight) * 1000) / 10 : null;
    return {
      ...r,
      tmAtTime: tm?.weight ?? null,
      tmUnit: tm?.unit ?? null,
      tmPercent,
      isPR: prRecordIds.has(r.id),
    };
  });

  return (
    <main className={styles.pageContainer}>
      <h1 className={styles.pageHeading}>Lift History</h1>
      <p className={styles.pageIntro}>
        Your logged lifts and Training Max (TM) progression over time.{' '}
        <Link href="/non-cycle/new">Record a non-cycle workout</Link>
      </p>
      {loadFailed && (
        <p role="status" className={styles.loadError}>
          We couldn’t load your latest history just now. This is usually
          temporary — refresh the page in a moment to try again.
        </p>
      )}
      {importsFailed && (
        <p role="status" className={styles.loadError}>
          Undoing an import isn’t available right now. Refresh the page in a moment to try again.
        </p>
      )}
      <HistoryTabs records={enriched} tmEntries={tmEntries} macrocycles={macrocycles} imports={imports} unit={unit} />
    </main>
  );
}
