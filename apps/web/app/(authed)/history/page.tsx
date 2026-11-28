import Link from 'next/link';
import {
  fetchCustomLifts,
  fetchImportBatches,
  fetchLiftRecords,
  fetchMacrocycles,
  fetchNonCycleRecords,
  fetchTrainingMaxHistory,
} from '@/lib/api';
import { getPreferredUnit } from '@/lib/preferences';
import { readUserPrograms } from '@/lib/read-user-programs';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import type {
  CustomLiftResponse,
  ImportBatchSummary,
  LiftRecordResponse,
  MacrocycleSummaryResponse,
  TrainingMaxHistoryEntryResponse,
  WeightUnit,
} from '@lifting-logbook/types';
import { liftListing } from '@/lib/liftNames';
import { buildTmAtTimeIndex } from '@/lib/tmAtTime';
import HistoryTabs from './HistoryTabs';
import styles from './history.module.css';

export type EnrichedRecord = LiftRecordResponse & {
  tmAtTime: number | null;
  tmUnit: WeightUnit | null;
  tmPercent: number | null;
  isPR: boolean;
};

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ program?: string | string[] }> }) {
  // Wrap the API calls so a transient failure (expired session token, API
  // unavailable) surfaces a non-blocking notice rather than crashing the server
  // component or silently rendering an empty page that reads as "no history yet".
  // The `.catch()` fallbacks keep the tabs rendering (graceful degradation);
  // `loadFailed` distinguishes a real fetch failure from a genuinely empty history.
  let loadFailed = false;
  let importsFailed = false;

  // Any of the lifter's programs, not only the active one, since an import can go into any of
  // them (#1300), including a template holding only macrocycles (#1304).
  const [{ program: requested }, { activeProgram, programs, failed: programsFailed }] = await Promise.all([
    searchParams,
    // fallback-covered-by: apps/web/app/(authed)/history/page.test.tsx
    readUserPrograms('HistoryPage', { macrocycles: true }),
  ]);
  if (programsFailed) loadFailed = true;
  // The program asked for, if it's one of the lifter's; else the active one, else their first.
  // None for an account with no program, whose history is only its non-cycle workouts.
  const program = programs.find((p) => p.id === requested)?.id ?? activeProgram ?? programs[0]?.id;

  // An account with no program has nothing of one to load.
  const fromProgram = <T,>(load: (program: string) => Promise<T>, none: T): Promise<T> =>
    program === undefined ? Promise.resolve(none) : load(program);

  const [programRecords, nonCycleRecords, { entries: tmEntries }, macrocycles, imports, customLifts, unit] = await Promise.all([
    // fallback-covered-by: apps/web/e2e/staging.spec.ts
    fromProgram(fetchLiftRecords, []).catch((): LiftRecordResponse[] => {
      loadFailed = true;
      return [];
    }),
    // Non-cycle workouts (#1184) are listed whichever program is shown.
    // fallback-covered-by: apps/web/app/(authed)/history/page.test.tsx
    fetchNonCycleRecords().catch((): LiftRecordResponse[] => {
      loadFailed = true;
      return [];
    }),
    // fallback-covered-by: apps/web/e2e/staging.spec.ts
    fromProgram(fetchTrainingMaxHistory, { entries: [] }).catch(() => {
      loadFailed = true;
      return { entries: [] as TrainingMaxHistoryEntryResponse[] };
    }),
    // fallback-covered-by: apps/web/app/(authed)/history/page.test.tsx
    fromProgram(fetchMacrocycles, []).catch((): MacrocycleSummaryResponse[] => {
      loadFailed = true;
      return [];
    }),
    // The imports Undo is offered for (#1257). Without them the history is whole but shows no
    // Undo, so the notice says only that.
    // fallback-covered-by: apps/web/app/(authed)/history/page.test.tsx
    fromProgram(fetchImportBatches, []).catch((): ImportBatchSummary[] => {
      importsFailed = true;
      return [];
    }),
    // Import stores a custom lift's sets under its id (#1290), so without these they show the id (#1503).
    // fallback-covered-by: apps/web/app/(authed)/history/page.imported.test.tsx
    fetchCustomLifts().catch((): CustomLiftResponse[] => {
      loadFailed = true;
      return [];
    }),
    getPreferredUnit(),
  ]);

  const records = [...programRecords, ...nonCycleRecords];
  const sortedRecords = records.slice().sort((a, b) => b.date.localeCompare(a.date));

  // A record stored by catalog id shares its lift's PR with a record under the lift's name (#1135),
  // and one stored by custom lift id with a record under the custom lift's name (#1503).
  const liftNames = customLifts.map(({ id, name }) => ({ id, name }));
  const listing = liftListing(sortedRecords.map((r) => r.lift), liftNames);
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
      {programs.length > 1 && programs.some((p) => p.id === program) && (
        // A plain GET form, so it works before the page hydrates. Only when the program shown is
        // one of its options, or the select would show another as chosen.
        <form method="get" action="/history" className={styles.programPicker}>
          <label htmlFor="history-program">Program</label>
          <select id="history-program" name="program" defaultValue={program}>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === activeProgram ? `${p.name} (active)` : p.name}
              </option>
            ))}
          </select>
          <button type="submit">Show</button>
        </form>
      )}
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
      <HistoryTabs
        records={enriched}
        tmEntries={tmEntries}
        macrocycles={macrocycles}
        imports={imports}
        customLifts={liftNames}
        unit={unit}
      />
    </main>
  );
}
