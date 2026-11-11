import { fetchUserSettings } from '@/lib/api';
import type { UserSettingsResponse } from '@lifting-logbook/types';
import WeightIncrementForm from './WeightIncrementForm';

const DEFAULT_SETTINGS: UserSettingsResponse = {
  activeProgram: null,
  workoutSchedule: null,
  defaultWeightIncrement: null,
  unit: null,
  defaultProgression: null,
};

export default async function WeightRoundingPage() {
  // Fall back to empty settings when the API is unreachable — matches
  // settings/schedule/page.tsx, and keeps the build-time prerender from crashing
  // when no API is running.
  // fallback-covered-by: apps/web/app/(authed)/settings/weight-rounding/page.test.tsx
  const settings = await fetchUserSettings().catch(() => DEFAULT_SETTINGS);
  return <WeightIncrementForm initialIncrement={settings.defaultWeightIncrement} />;
}
