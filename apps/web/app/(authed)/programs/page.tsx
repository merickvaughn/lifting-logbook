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
    // allow-skewed: with no complexes the editor offers every lift and no complex, which is what a lifter with none sees too.
    fetchBarbellComplexes().catch((err: unknown) => {
      console.error('[ProgramsPage] complexes fetch failed, the editor offers lifts only', err);
      return [];
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
