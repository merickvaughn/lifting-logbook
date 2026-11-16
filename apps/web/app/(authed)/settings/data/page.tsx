import type { CustomProgramSummaryResponse } from '@lifting-logbook/types';
import { fetchCustomPrograms } from '@/lib/api';
import { getUserSettings } from '@/lib/active-program';
import { userPrograms } from '@/lib/user-programs';
import DownloadAll from './DownloadAll';
import SetsExport from './SetsExport';
import TrainingData from './TrainingData';

/**
 * Settings > Data: the whole-logbook download (#947), a filtered sets download, Clear data and
 * its backups (#1310). The programs only fill the sets filter, so if they can't be read the
 * filter still offers all programs and non-cycle workouts.
 */
export default async function DataSettingsPage() {
  const [activeProgram, customPrograms] = await Promise.all([
    // fallback-covered-by: apps/web/app/(authed)/settings/data/page.test.tsx
    getUserSettings().then(
      (settings) => settings.activeProgram,
      (e: unknown): string | null => {
        console.error('DataSettingsPage: user settings fetch failed, listing the custom programs only', e);
        return null;
      },
    ),
    // fallback-covered-by: apps/web/app/(authed)/settings/data/page.test.tsx
    fetchCustomPrograms().catch((e: unknown): CustomProgramSummaryResponse[] => {
      console.error('DataSettingsPage: custom programs fetch failed, listing the active program only', e);
      return [];
    }),
  ]);

  return (
    <>
      <DownloadAll />
      <SetsExport programs={userPrograms(customPrograms, activeProgram)} />
      <TrainingData />
    </>
  );
}
