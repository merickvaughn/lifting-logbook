import Link from 'next/link';
import { fetchCustomPrograms, fetchUserSettings } from '@/lib/api';
import type { UserSettingsResponse } from '@lifting-logbook/types';
import ProgramsTabs from './ProgramsTabs';
import styles from './programs.module.css';

const DEFAULT_SETTINGS: UserSettingsResponse = {
  activeProgram: null,
  workoutSchedule: null,
  defaultWeightIncrement: null,
  unit: null,
};

export default async function ProgramsPage() {
  const [settings, customPrograms] = await Promise.all([
    fetchUserSettings().catch(() => DEFAULT_SETTINGS),
    fetchCustomPrograms().catch(() => []),
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
      />
    </main>
  );
}
