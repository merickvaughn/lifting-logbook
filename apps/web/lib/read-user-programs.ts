import type { CustomProgramSummaryResponse } from '@lifting-logbook/types';
import { getUserSettings } from './active-program';
import { fetchCustomPrograms, fetchRecordedPrograms } from './api';
import { isCustomProgramId, userPrograms, type UserProgram } from './user-programs';

/**
 * The lifter's programs for a server page (History, Settings > Data). It reads settings rather
 * than getActiveProgram(), whose fallback names a template the account may not have. It adds the
 * templates holding the lifter's sets, which they may not be able to pick (#1454), and with
 * `macrocycles` those holding their macrocycles, for History (#1304). If any read fails, it logs,
 * sets `failed` and returns the rest, so the page still renders. `caller` names the page in the log.
 */
export async function readUserPrograms(
  caller: string,
  options: { macrocycles?: boolean } = {},
): Promise<{ activeProgram: string | null; programs: UserProgram[]; failed: boolean }> {
  let failed = false;
  let customFailed = false;
  const [activeProgram, customPrograms, recorded] = await Promise.all([
    // fallback-covered-by: apps/web/app/(authed)/settings/data/page.test.tsx
    getUserSettings().then(
      (settings) => settings.activeProgram,
      (e: unknown): string | null => {
        console.error(`${caller}: user settings fetch failed, choosing from the custom programs`, e);
        failed = true;
        return null;
      },
    ),
    // fallback-covered-by: apps/web/app/(authed)/settings/data/page.test.tsx
    fetchCustomPrograms().catch((e: unknown): CustomProgramSummaryResponse[] => {
      console.error(`${caller}: custom programs fetch failed, offering the active program only`, e);
      failed = true;
      customFailed = true;
      return [];
    }),
    // fallback-covered-by: apps/web/app/(authed)/history/page.test.tsx
    fetchRecordedPrograms(options).catch((e: unknown): string[] => {
      console.error(`${caller}: recorded programs fetch failed, offering the custom and active programs only`, e);
      failed = true;
      return [];
    }),
  ]);
  // Unread custom programs would make every recorded custom id look deleted (#1465).
  const listable = customFailed ? recorded.filter((id) => !isCustomProgramId(id)) : recorded;
  return { activeProgram, programs: userPrograms(customPrograms, activeProgram, listable), failed };
}
