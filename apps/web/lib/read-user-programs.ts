import type { CustomProgramSummaryResponse } from '@lifting-logbook/types';
import { getUserSettings } from './active-program';
import { fetchCustomPrograms } from './api';
import { userPrograms, type UserProgram } from './user-programs';

/**
 * The lifter's programs for a server page (History, Settings > Data). It reads settings rather
 * than getActiveProgram(), whose fallback names a template the account may not have. If either
 * read fails, it logs, sets `failed` and returns the rest, so the page still renders.
 * `caller` names the page in the log.
 */
export async function readUserPrograms(
  caller: string,
): Promise<{ activeProgram: string | null; programs: UserProgram[]; failed: boolean }> {
  let failed = false;
  const [activeProgram, customPrograms] = await Promise.all([
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
      return [];
    }),
  ]);
  return { activeProgram, programs: userPrograms(customPrograms, activeProgram), failed };
}
