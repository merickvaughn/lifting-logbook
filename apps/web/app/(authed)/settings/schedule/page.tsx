import { fetchUserSettings } from '@/lib/api';
import type { UserSettingsResponse } from '@lifting-logbook/types';
import ScheduleForm from './ScheduleForm';

const DEFAULT_SETTINGS: UserSettingsResponse = {
  activeProgram: null,
  workoutSchedule: null,
  defaultWeightIncrement: null,
  unit: null,
};

export default async function SchedulePage() {
  // Fall back to empty settings when the API is unreachable — matches /programs and
  // /macrocycle, and keeps the build-time prerender from crashing when no API is running.
  // fallback-covered-by: apps/web/app/(authed)/settings/schedule/page.test.tsx
  const settings = await fetchUserSettings().catch(() => DEFAULT_SETTINGS);
  return <ScheduleForm initialSchedule={settings.workoutSchedule} />;
}
