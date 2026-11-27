import Link from 'next/link';
import { fetchBarbellComplexes, fetchCustomPrograms, fetchUserSettings } from '@/lib/api';
import type { UserSettingsResponse } from '@lifting-logbook/types';
import ProgramsTabs from './ProgramsTabs';
import styles from './programs.module.css';

const DEFAULT_SETTINGS: UserSettingsResponse = {
  activeProgram: null,
  workoutSchedule: null,
  defaultWeightIncrement: null,
  unit: null,
  defaultProgression: null,
};

export default async function ProgramsPage() {
  const [settings, customPrograms, complexes] = await Promise.all([
    fetchUserSettings().catch(() => DEFAULT_SETTINGS),
    fetchCustomPrograms().catch(() => []),
    // A failed read is null, not empty: the editor then offers lifts only, and names a row that
    // plans a complex as one it couldn't load rather than as deleted.
    // fallback-covered-by: apps/web/app/(authed)/programs/page.test.tsx
    fetchBarbellComplexes().catch((err: unknown) => {
      console.error('[ProgramsPage] complexes fetch failed, the editor offers lifts only', err);
      return null;
    }),
  ]);

  return (
    <main className={styles.container}>
      <h1 className={styles.heading}>Programs</h1>
      <p className={styles.focusLink}>
        <Link href="/programs/focus">Focus work</Link>: extra accessory work for one muscle area, a
        month or quarter at a time, on top of your program.
      </p>
      <ProgramsTabs
        activeProgram={settings.activeProgram}
        workoutSchedule={settings.workoutSchedule ?? null}
        defaultWeightIncrement={settings.defaultWeightIncrement}
        customPrograms={customPrograms}
        complexes={complexes}
      />
    </main>
  );
}
