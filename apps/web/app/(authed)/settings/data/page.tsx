import { readUserPrograms } from '@/lib/read-user-programs';
import DownloadAll from './DownloadAll';
import SetsExport from './SetsExport';
import TrainingData from './TrainingData';

/**
 * Settings > Data: the whole-logbook download (#947), a filtered sets download, Clear data and
 * its backups (#1310). The programs only fill the sets filter, so if they can't be read the
 * filter still offers all programs and non-cycle workouts.
 */
export default async function DataSettingsPage() {
  // fallback-covered-by: apps/web/app/(authed)/settings/data/page.test.tsx
  const { programs } = await readUserPrograms('DataSettingsPage');

  return (
    <>
      <DownloadAll />
      <SetsExport programs={programs} />
      <TrainingData />
    </>
  );
}
