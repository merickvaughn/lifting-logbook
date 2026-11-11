import { fetchUserSettings } from '@/lib/api';
import type { UserSettingsResponse } from '@lifting-logbook/types';
import UnitForm from './UnitForm';

const DEFAULT_SETTINGS: UserSettingsResponse = {
  activeProgram: null,
  workoutSchedule: null,
  defaultWeightIncrement: null,
  unit: null,
  defaultProgression: null,
};

export default async function UnitsPage() {
  // Fall back to empty settings when the API is unreachable — matches
  // settings/weight-rounding/page.tsx, and keeps the build-time prerender from crashing
  // when no API is running.
  // fallback-covered-by: apps/web/app/(authed)/settings/units/page.test.tsx
  const settings = await fetchUserSettings().catch(() => DEFAULT_SETTINGS);
  return <UnitForm initialUnit={settings.unit} />;
}
