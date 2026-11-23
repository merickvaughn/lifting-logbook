import { readUserPrograms } from '@/lib/read-user-programs';
import DownloadAll from './DownloadAll';
import SetsExport from './SetsExport';
import GoogleSheet from './GoogleSheet';
import { GOOGLE_SHEET_NOTICE_PARAM, isGoogleSheetNotice } from './googleSheetNotice';
import TrainingData from './TrainingData';

/**
 * Settings > Data: the whole-logbook download (#947), a filtered sets download, Clear data and
 * its backups (#1310), and Link a Google Sheet (#1433), whose callback route sends the lifter back
 * here with `?google_sheet=<result>`. The programs only fill the sets filter, so if they can't be read the
 * filter still offers all programs and non-cycle workouts.
 */
export default async function DataSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const notice = (await searchParams)?.[GOOGLE_SHEET_NOTICE_PARAM];
  // fallback-covered-by: apps/web/app/(authed)/settings/data/page.test.tsx
  const { programs } = await readUserPrograms('DataSettingsPage');

  return (
    <>
      <DownloadAll />
      <SetsExport programs={programs} />
      <GoogleSheet notice={isGoogleSheetNotice(notice) ? notice : undefined} />
      <TrainingData />
    </>
  );
}
